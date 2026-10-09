import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: vi.fn(async () => 1), scheduleJob: vi.fn(async () => undefined) }));

import { clearListeners, type DomainEvent } from "@/lib/events/emit";
import { enqueue } from "@/lib/jobs/enqueue";
import { classifyAttempt, MAX_ATTEMPTS, nextDelaySeconds, RETRY_DELAYS_SECONDS } from "@/lib/webhooks/backoff";
import { isWebhookEvent, WEBHOOK_EVENT_NAMES, WEBHOOK_EVENTS } from "@/lib/webhooks/events";
import { fanoutEvent, matchingSubscriptions } from "@/lib/webhooks/fanout";
import { buildEnvelope, sanitizePayload } from "@/lib/webhooks/payload";
import { generateWebhookSecret, signPayload, verifySignature } from "@/lib/webhooks/sign";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

describe("signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "e1", type: "message.received" });

  it("signs as t=<unix>,v1=<hex> and verifies", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, body, header, { nowSeconds: 1_700_000_100 })).toBe(true);
  });

  it("matches independently computed HMAC-SHA256 vectors so receivers in any language agree", () => {
    // Computed with Python's hmac/hashlib, not with this module.
    expect(signPayload("k", "x", 1)).toBe("t=1,v1=976cb87e4f568d1c0f03f32859e90af8597cf00b978ba37c229c97d3a15b8449");
    expect(signPayload("whsec_vector", '{"a":1}', 1700000000)).toBe(
      "t=1700000000,v1=5d485af0d9ddc3522d7a396ce60598f0d5fbb3bacdb1924001168092bc407c18",
    );
    // and every input matters
    expect(signPayload("k", "y", 1)).not.toBe(signPayload("k", "x", 1));
    expect(signPayload("k2", "x", 1)).not.toBe(signPayload("k", "x", 1));
    expect(signPayload("k", "x", 2)).not.toBe(signPayload("k", "x", 1));
  });

  it("rejects a tampered body, wrong secret, and a stale or future timestamp", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    const now = 1_700_000_100;
    expect(verifySignature(secret, body + " ", header, { nowSeconds: now })).toBe(false);
    expect(verifySignature("whsec_other", body, header, { nowSeconds: now })).toBe(false);
    expect(verifySignature(secret, body, header, { nowSeconds: 1_700_000_000 + 301 })).toBe(false);
    expect(verifySignature(secret, body, header, { nowSeconds: 1_700_000_000 - 301 })).toBe(false);
    expect(verifySignature(secret, body, header, { nowSeconds: 1_700_000_000 + 301, toleranceSeconds: 600 })).toBe(true);
  });

  it("cannot be replayed with a fresh timestamp (the timestamp is signed)", () => {
    const old = signPayload(secret, body, 1_700_000_000);
    const forged = old.replace("t=1700000000", "t=1700009999");
    expect(verifySignature(secret, body, forged, { nowSeconds: 1_700_009_999 })).toBe(false);
  });

  it.each([null, undefined, "", "garbage", "t=abc,v1=00", "t=1700000000", "v1=00", "t=1700000000,v1=zz", "t=1700000000,v1="])("rejects malformed header %j", (h) => {
    expect(verifySignature(secret, body, h as string, { nowSeconds: 1_700_000_100 })).toBe(false);
  });

  it("generates distinct whsec_ secrets", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 100 }, generateWebhookSecret)).size).toBe(100);
  });
});

describe("retry schedule", () => {
  it("backs off 1m, 5m, 30m, 2h, 6h then gives up after six attempts", () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([60, 300, 1800, 7200, 21600]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5].map(nextDelaySeconds)).toEqual([60, 300, 1800, 7200, 21600]);
    expect(nextDelaySeconds(6)).toBeNull();
    expect(nextDelaySeconds(99)).toBeNull();
  });

  it("classifies attempts", () => {
    expect(classifyAttempt({ status: 200 }, 1)).toEqual({ status: "success", responseCode: 200, error: null, retryInSeconds: null });
    expect(classifyAttempt({ status: 204 }, 3).status).toBe("success");
    expect(classifyAttempt({ status: 500 }, 1)).toMatchObject({ status: "failed", responseCode: 500, error: "HTTP 500", retryInSeconds: 60 });
    expect(classifyAttempt({ status: 429 }, 2)).toMatchObject({ status: "failed", retryInSeconds: 300 });
    expect(classifyAttempt({ status: 404 }, 1)).toMatchObject({ status: "failed" });
    expect(classifyAttempt({ status: 302 }, 1)).toMatchObject({ status: "failed", error: expect.stringMatching(/redirects are not followed/) });
    expect(classifyAttempt({ status: 410 }, 1)).toMatchObject({ status: "dead", retryInSeconds: null });
    expect(classifyAttempt({ status: 500 }, 6)).toMatchObject({ status: "dead", error: expect.stringMatching(/Gave up after 6 attempts/), retryInSeconds: null });
    expect(classifyAttempt({ error: { message: "Request timed out." } }, 1)).toMatchObject({ status: "failed", error: "Timed out waiting for a response." });
    expect(classifyAttempt({ error: { message: "ECONNREFUSED" } }, 1)).toMatchObject({ status: "failed", error: "Could not connect to the endpoint." });
    expect(classifyAttempt({ error: { name: "UnsafeUrlError", message: "x" } }, 1)).toMatchObject({ status: "dead", retryInSeconds: null });
  });

  it("never puts a response body or the raw error text in the log message", () => {
    const o = classifyAttempt({ error: { message: "connect ECONNREFUSED 10.0.0.5:443 with secret-token" } }, 1);
    expect(o.error).not.toContain("10.0.0.5");
    expect(o.error).not.toContain("secret-token");
  });
});

describe("payload sanitising (PHI boundary)", () => {
  it("keeps opaque ids and non-identifying enums, drops everything else", () => {
    const out = sanitizePayload({
      conversation_id: "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e",
      message_id: "m1",
      contact_id: null,
      kind: "text",
      status: "failed",
      code: 131050,
      auto: true,
      by: "u1",
      // none of these may leave the platform
      body: "My chest hurts, call me on +971501234567",
      text: "hi",
      contact_name: "Amal Khan",
      phone: "+971501234567",
      wa_id: "971501234567",
      external_id: "PIN-884412",
      email: "pat@example.test",
      ad_referral: { headline: "x" },
      reason: "free text from Meta",
    });
    expect(out).toEqual({ conversation_id: "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e", message_id: "m1", contact_id: null, kind: "text", status: "failed", code: 131050, auto: true, by: "u1" });
  });

  it("drops an allowed key whose value looks like text, not an id or enum", () => {
    expect(sanitizePayload({ kind: "a long sentence with spaces in it", status: "x".repeat(65), contact_id: "has space", message_id: { nested: 1 } })).toEqual({});
  });

  it("wraps into an envelope with a stable shape", () => {
    const e = buildEnvelope({ id: "ev1", type: "message.received", orgId: "org1", createdAt: new Date("2026-01-01T00:00:00Z"), payload: { message_id: "m1", body: "secret" } });
    expect(e).toEqual({ id: "ev1", type: "message.received", created_at: "2026-01-01T00:00:00.000Z", org_id: "org1", data: { message_id: "m1" } });
    expect(JSON.stringify(e)).not.toContain("secret");
  });
});

describe("event catalogue", () => {
  it("lists unique, labelled events and recognises them", () => {
    expect(new Set(WEBHOOK_EVENT_NAMES).size).toBe(WEBHOOK_EVENTS.length);
    for (const e of WEBHOOK_EVENTS) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(isWebhookEvent(e.name)).toBe(true);
    }
    expect(isWebhookEvent("webhook.test")).toBe(false);
    expect(isWebhookEvent("nope")).toBe(false);
  });
});

describe("fan-out", () => {
  const subs = [
    { id: "s1", org_id: "org1", events: ["message.received", "contact.created"], active: true },
    { id: "s2", org_id: "org1", events: ["contact.created"], active: true },
    { id: "s3", org_id: "org1", events: ["message.received"], active: false },
    { id: "s4", org_id: "orgB", events: ["message.received"], active: true },
  ];
  const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
    orgId: "org1",
    name: "message.received",
    at: new Date("2026-01-01T00:00:00Z"),
    payload: { conversation_id: "c1", message_id: "m1", contact_id: "p1", kind: "text", body: "PHI: my symptoms", contact_name: "Amal" },
    ...over,
  });
  const setup = () => {
    const admin = createFakeAdmin({ webhook_subscriptions: subs, webhook_deliveries: [] }, { unique: { webhook_deliveries: [["subscription_id", "event_id"]] } });
    return { admin, as: admin as unknown as AdminClient };
  };

  beforeEach(() => vi.mocked(enqueue).mockClear());

  it("matches active subscriptions that asked for the event", () => {
    expect(matchingSubscriptions(subs, "message.received").map((s) => s.id)).toEqual(["s1", "s4"]);
    expect(matchingSubscriptions(subs, "contact.created").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(matchingSubscriptions(subs, "template.status_changed")).toEqual([]);
  });

  it("creates one pending delivery per matching subscription of THIS org, with a sanitised envelope, and queues it", async () => {
    const { admin, as } = setup();
    expect(await fanoutEvent(event(), as)).toBe(1);
    const rows = admin._rows("webhook_deliveries");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: "org1", subscription_id: "s1", event: "message.received", status: "pending" });
    const envelope = rows[0].payload as { org_id: string; type: string; data: Record<string, unknown> };
    expect(envelope).toMatchObject({ org_id: "org1", type: "message.received" });
    expect(envelope.data).toEqual({ conversation_id: "c1", message_id: "m1", contact_id: "p1", kind: "text" });
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/PHI|Amal/);
    expect(vi.mocked(enqueue).mock.calls).toEqual([["webhooks_out", { delivery_id: rows[0].id }]]);
  });

  it("fans one event out to every interested endpoint with a shared event id", async () => {
    const { admin, as } = setup();
    expect(await fanoutEvent(event({ name: "contact.created", payload: { contact_id: "p1" } }), as)).toBe(2);
    const rows = admin._rows("webhook_deliveries");
    expect(rows.map((r) => r.subscription_id).sort()).toEqual(["s1", "s2"]);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("does nothing for events nobody subscribed to or that are not subscribable", async () => {
    const { admin, as } = setup();
    expect(await fanoutEvent(event({ name: "template.status_changed" }), as)).toBe(0);
    expect(await fanoutEvent(event({ name: "nope" as never }), as)).toBe(0);
    expect(await fanoutEvent(event({ orgId: "orgC" }), as)).toBe(0);
    expect(admin._rows("webhook_deliveries")).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("emit() hands events to webhook fan-out", () => {
  const original = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = original.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = original.key;
    if (original.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (original.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.doUnmock("@/lib/webhooks/fanout");
    vi.resetModules();
    clearListeners();
  });

  it("calls fan-out when a database is configured, and a failing fan-out never breaks the emitter", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    const fanout = vi.fn(async () => {
      throw new Error("database down");
    });
    vi.resetModules();
    vi.doMock("@/lib/webhooks/fanout", () => ({ fanoutEvent: fanout }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { emit: freshEmit } = await import("@/lib/events/emit");
    const ev = await freshEmit("org1", "message.received", { message_id: "m1" });
    expect(ev.name).toBe("message.received");
    expect(fanout).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[events] webhook fan-out failed", { name: "message.received", error: "Error" });
    spy.mockRestore();
  });

  it("skips fan-out entirely without database configuration (tests, build)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fanout = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/webhooks/fanout", () => ({ fanoutEvent: fanout }));
    const { emit: freshEmit } = await import("@/lib/events/emit");
    await freshEmit("org1", "message.received", {});
    expect(fanout).not.toHaveBeenCalled();
  });
});

