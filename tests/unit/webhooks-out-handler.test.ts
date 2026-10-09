import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: vi.fn(async () => 1), scheduleJob: vi.fn(async () => undefined) }));
vi.mock("@/lib/net/safe-request", () => ({ safeRequest: vi.fn() }));

import { encryptSecret } from "@/lib/crypto";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { getHandler } from "@/lib/jobs/registry";
import "@/lib/jobs/handlers/webhooks-out";
import { PermanentJobError, type JobContext } from "@/lib/jobs/types";
import { safeRequest } from "@/lib/net/safe-request";
import { UnsafeUrlError } from "@/lib/net/url-guard";
import { verifySignature } from "@/lib/webhooks/sign";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

const SECRET = "whsec_handler_test_secret";
const DELIVERY_ID = "11111111-1111-4111-8111-111111111111";
const ENVELOPE = { id: "e1", type: "message.received", created_at: "2026-01-01T00:00:00.000Z", org_id: "org1", data: { message_id: "m1" } };

function setup(over: { delivery?: Record<string, unknown>; sub?: Record<string, unknown> | null; secret?: boolean } = {}) {
  const admin = createFakeAdmin({
    webhook_deliveries: [{ id: DELIVERY_ID, org_id: "org1", subscription_id: "s1", event: "message.received", event_id: "e1", payload: ENVELOPE, status: "pending", attempts: 0, ...over.delivery }],
    webhook_subscriptions: over.sub === null ? [] : [{ id: "s1", url: "https://hooks.example.test/pulse?token=abc", active: true, ...over.sub }],
    webhook_secrets: over.secret === false ? [] : [{ subscription_id: "s1", secret_enc: encryptSecret(SECRET) }],
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = { queue: "webhooks_out", msgId: 1, readCt: 1, enqueuedAt: new Date().toISOString(), admin: admin as unknown as AdminClient, log } as unknown as JobContext;
  const run = (payload: unknown = { delivery_id: DELIVERY_ID }) => getHandler("webhooks_out")!.handler(payload as never, ctx);
  const delivery = () => admin._rows("webhook_deliveries")[0];
  return { admin, log, run, delivery };
}

const respond = (status: number) => vi.mocked(safeRequest).mockResolvedValueOnce({ status, headers: {}, body: Buffer.from("receiver says: secret details"), finalUrl: "" });

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
beforeEach(() => {
  vi.mocked(safeRequest).mockReset();
  vi.mocked(scheduleJob).mockClear();
});

describe("webhooks_out handler", () => {
  it("POSTs the envelope with a signature the receiver can verify, and records success", async () => {
    const { run, delivery, log } = setup();
    respond(200);
    await run();

    expect(safeRequest).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(safeRequest).mock.calls[0];
    expect(url).toBe("https://hooks.example.test/pulse?token=abc");
    expect(opts).toMatchObject({ method: "POST", maxRedirects: 0, onOverflow: "truncate" });
    expect(opts?.body).toBe(JSON.stringify(ENVELOPE));
    const h = opts?.headers as Record<string, string>;
    expect(h["X-Pulse-Event"]).toBe("message.received");
    expect(h["X-Pulse-Delivery"]).toBe(DELIVERY_ID);
    expect(verifySignature(SECRET, opts?.body as string, h["X-Pulse-Signature"])).toBe(true);
    expect(verifySignature("whsec_wrong", opts?.body as string, h["X-Pulse-Signature"])).toBe(false);

    expect(delivery()).toMatchObject({ status: "success", attempts: 1, response_code: 200, error: null });
    expect(delivery().delivered_at).toBeTruthy();
    expect(scheduleJob).not.toHaveBeenCalled();
    // ids and codes only: no URL (it can carry tokens), no payload, no response body
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toMatch(/hooks\.example|token=abc|receiver says|m1/);
  });

  it("schedules a retry with backoff after a non-2xx response, without storing the response body", async () => {
    const { run, delivery } = setup();
    respond(500);
    const before = Date.now();
    await run();
    expect(delivery()).toMatchObject({ status: "failed", attempts: 1, response_code: 500, error: "HTTP 500" });
    expect(JSON.stringify(delivery())).not.toContain("receiver says");
    const next = new Date(delivery().next_attempt_at as string).getTime();
    expect(next - before).toBeGreaterThanOrEqual(59_000);
    expect(next - before).toBeLessThan(62_000);
    expect(scheduleJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleJob).mock.calls[0][0]).toMatchObject({
      kind: "webhook.retry",
      payload: { delivery_id: DELIVERY_ID },
      orgId: "org1",
      dedupeKey: `webhook:${DELIVERY_ID}:1`,
    });
  });

  it("walks the retry ladder and marks the delivery dead after the sixth attempt", async () => {
    const { run, delivery } = setup({ delivery: { status: "failed", attempts: 4 } });
    respond(503);
    await run(); // the 5th attempt fails: one more retry (6 h out) remains
    expect(delivery()).toMatchObject({ status: "failed", attempts: 5 });
    expect(vi.mocked(scheduleJob).mock.calls[0][0].dedupeKey).toBe(`webhook:${DELIVERY_ID}:5`);

    vi.mocked(scheduleJob).mockClear();
    respond(503);
    await run(); // 6th attempt
    expect(delivery()).toMatchObject({ status: "dead", attempts: 6, next_attempt_at: null });
    expect(delivery().error).toMatch(/Gave up after 6 attempts/);
    expect(scheduleJob).not.toHaveBeenCalled();
  });

  it("records a connection failure as retryable and never stores the raw error text", async () => {
    const { run, delivery } = setup();
    vi.mocked(safeRequest).mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.1.2.3:443"));
    await run();
    expect(delivery()).toMatchObject({ status: "failed", error: "Could not connect to the endpoint.", response_code: null });
    expect(scheduleJob).toHaveBeenCalledTimes(1);
  });

  it("marks a delivery dead, with no retry, when the endpoint resolves to a private address", async () => {
    const { run, delivery } = setup();
    vi.mocked(safeRequest).mockRejectedValueOnce(new UnsafeUrlError("That address is not publicly reachable."));
    await run();
    expect(delivery()).toMatchObject({ status: "dead", attempts: 1 });
    expect(delivery().error).toMatch(/non-public address/);
    expect(scheduleJob).not.toHaveBeenCalled();
  });

  it("treats HTTP 410 as the endpoint being gone", async () => {
    const { run, delivery } = setup();
    respond(410);
    await run();
    expect(delivery()).toMatchObject({ status: "dead", response_code: 410 });
    expect(scheduleJob).not.toHaveBeenCalled();
  });

  it("is idempotent: a delivery already finished is not sent again", async () => {
    for (const status of ["success", "dead"]) {
      const { run } = setup({ delivery: { status, attempts: 1 } });
      await run();
    }
    expect(safeRequest).not.toHaveBeenCalled();
  });

  it("drops the delivery when the endpoint was paused, deleted or has no secret", async () => {
    for (const over of [{ sub: { active: false } }, { sub: null }, { secret: false }]) {
      const { run, delivery } = setup(over);
      await run();
      expect(delivery()).toMatchObject({ status: "dead", error: "The endpoint is disabled or was deleted." });
    }
    expect(safeRequest).not.toHaveBeenCalled();
  });

  it("returns quietly when the delivery was deleted, and rejects a malformed job", async () => {
    const { run } = setup();
    await expect(run({ delivery_id: "22222222-2222-4222-8222-222222222222" })).resolves.toBeUndefined();
    await expect(run({ delivery_id: "nope" })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(run({})).rejects.toBeInstanceOf(PermanentJobError);
    expect(safeRequest).not.toHaveBeenCalled();
  });
});
