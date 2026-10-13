import { describe, expect, it } from "vitest";

import { integrationDef, allFields, validateFields } from "@/lib/integrations/catalog";
import { readinessProblems } from "@/lib/integrations/readiness";
import { createCapiClient } from "@/lib/integrations/capi/client";
import { readCapiConfig } from "@/lib/integrations/capi/config";
import {
  capiConsent,
  CONSENT_BASIS_PHRASE,
  withinAttributionWindow,
} from "@/lib/integrations/capi/consent";
import {
  buildCapiEvent,
  capiEventId,
  CAPI_EVENT_NAMES,
  type BuildCapiInput,
} from "@/lib/integrations/capi/event";
import { createFakeCapiClient } from "@/lib/integrations/capi/fake";
import {
  hashEmail,
  hashPhone,
  normalizeEmail,
  normalizePhoneDigits,
  sha256Hex,
} from "@/lib/integrations/capi/hash";
import { parseReferral } from "@/lib/integrations/capi/server";
import type { CallRecord } from "@/lib/integrations/client";

describe("hashing (Meta's rules)", () => {
  it("is SHA-256 as lower-case hex, with the standard test vectors", () => {
    expect(sha256Hex("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("normalises an e-mail (trim, lower case) before hashing", () => {
    const expected = "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b";
    expect(hashEmail("test@example.com")).toBe(expected);
    expect(hashEmail("  Test@Example.COM ")).toBe(expected);
    expect(normalizeEmail("TEST@example.com")).toBe("test@example.com");
    for (const bad of ["", "no-at-sign", "a@b", "a b@c.com", "a@@b.com", null, undefined])
      expect(hashEmail(bad as string), String(bad)).toBeNull();
  });

  it("hashes a phone as digits only, country code included, no plus and no leading zeros", () => {
    const expected = "b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5"; // 971501234567
    expect(hashPhone("+971501234567")).toBe(expected);
    expect(hashPhone("+971 50 123 4567")).toBe(expected);
    expect(hashPhone("(971) 50-123-4567")).toBe(expected);
    expect(hashPhone("00971501234567")).toBe(expected);
    expect(normalizePhoneDigits("+971 50 123 4567")).toBe("971501234567");
    for (const bad of ["", "12345", "abc", "+" + "9".repeat(16), null, undefined])
      expect(hashPhone(bad as string), String(bad)).toBeNull();
  });
});

describe("buildCapiEvent", () => {
  const base: BuildCapiInput = {
    eventName: "Schedule",
    eventId: "evt-0123456789abcdef",
    eventTime: new Date("2026-10-19T08:00:00.900Z"),
    ctwaClid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LE",
    wabaId: "102290129340398",
  };

  it("builds exactly the business-messaging shape and nothing else", () => {
    const r = buildCapiEvent(base);
    expect(r).toEqual({
      ok: true,
      payload: {
        data: [
          {
            event_name: "Schedule",
            event_time: 1_792_396_800,
            event_id: "evt-0123456789abcdef",
            action_source: "business_messaging",
            messaging_channel: "whatsapp",
            user_data: {
              whatsapp_business_account_id: "102290129340398",
              ctwa_clid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LE",
            },
          },
        ],
      },
    });
  });

  it("sends the click id exactly as given (never altered or hashed)", () => {
    const clid = "AbC_dEf-123.XYZ==";
    const r = buildCapiEvent({ ...base, ctwaClid: clid });
    expect(r.ok && r.payload.data[0].user_data.ctwa_clid).toBe(clid);
  });

  it("hashes optional identifiers and adds the test event code only when given", () => {
    const r = buildCapiEvent({
      ...base,
      phone: "+971 50 123 4567",
      email: " Test@Example.com ",
      testEventCode: " TEST12345 ",
    });
    expect(r.ok && r.payload.test_event_code).toBe("TEST12345");
    const u = r.ok ? r.payload.data[0].user_data : null;
    expect(u?.ph).toEqual(["b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5"]);
    expect(u?.em).toEqual(["973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b"]);
    expect(JSON.stringify(r)).not.toContain("971501234567");
    expect(JSON.stringify(r)).not.toContain("example.com");
    const none = buildCapiEvent({ ...base, phone: "junk", testEventCode: "  " });
    expect(none.ok && "test_event_code" in none.payload).toBe(false);
    expect(none.ok && "ph" in none.payload.data[0].user_data).toBe(false);
  });

  it("can only produce an allow-listed set of keys: no health information, no value, no custom data", () => {
    for (const name of CAPI_EVENT_NAMES) {
      const r = buildCapiEvent({
        ...base,
        eventName: name,
        phone: "+971501234567",
        email: "a@b.co",
        testEventCode: "T1",
        // hostile extras that a careless caller might pass must not survive
        ...({
          value: 250,
          currency: "AED",
          service: "Cardiology",
          doctor: "Dr X",
          diagnosis: "Y",
        } as object),
      } as BuildCapiInput);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(Object.keys(r.payload).sort()).toEqual(["data", "test_event_code"]);
      expect(Object.keys(r.payload.data[0]).sort()).toEqual(
        [
          "action_source",
          "event_id",
          "event_name",
          "event_time",
          "messaging_channel",
          "user_data",
        ].sort(),
      );
      expect(Object.keys(r.payload.data[0].user_data).sort()).toEqual(
        ["ctwa_clid", "em", "ph", "whatsapp_business_account_id"].sort(),
      );
      const text = JSON.stringify(r.payload);
      for (const word of [
        "Cardiology",
        "Dr X",
        "diagnosis",
        "AED",
        "custom_data",
        "value",
        "currency",
      ])
        expect(text, word).not.toContain(word);
    }
  });

  it("allows only Contact, Lead and Schedule", () => {
    expect([...CAPI_EVENT_NAMES]).toEqual(["Contact", "Lead", "Schedule"]);
    expect(buildCapiEvent({ ...base, eventName: "Purchase" as never })).toEqual({
      ok: false,
      error: "unsupported_event",
    });
  });

  it("refuses a missing click id, a bad business account id, a missing event id and a bad time", () => {
    expect(buildCapiEvent({ ...base, ctwaClid: "" })).toEqual({ ok: false, error: "no_click_id" });
    expect(buildCapiEvent({ ...base, ctwaClid: "x".repeat(501) })).toEqual({
      ok: false,
      error: "no_click_id",
    });
    expect(buildCapiEvent({ ...base, wabaId: "" })).toEqual({ ok: false, error: "no_waba" });
    expect(buildCapiEvent({ ...base, wabaId: "abc" })).toEqual({ ok: false, error: "no_waba" });
    expect(buildCapiEvent({ ...base, eventId: "" })).toEqual({ ok: false, error: "no_event_id" });
    expect(buildCapiEvent({ ...base, eventTime: new Date("nope") })).toEqual({
      ok: false,
      error: "bad_time",
    });
  });

  it("makes a stable event id that does not expose the record id", () => {
    const id = capiEventId("org-1", "Schedule", "11111111-2222-3333-4444-555555555555");
    expect(id).toBe(capiEventId("org-1", "Schedule", "11111111-2222-3333-4444-555555555555"));
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(id).not.toContain("1111");
    expect(capiEventId("org-1", "Lead", "11111111-2222-3333-4444-555555555555")).not.toBe(id);
    expect(capiEventId("org-2", "Schedule", "11111111-2222-3333-4444-555555555555")).not.toBe(id);
  });
});

describe("consent and window", () => {
  const opted = { promotions_opt_in: true, stop_marketing: false };

  it("by default needs an opt-in and honours a stop", () => {
    expect(capiConsent("contact_opt_in", opted)).toEqual({ ok: true });
    expect(capiConsent("contact_opt_in", { ...opted, promotions_opt_in: false })).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(capiConsent("contact_opt_in", { promotions_opt_in: null })).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(capiConsent("contact_opt_in", { ...opted, stop_marketing: true })).toEqual({
      ok: false,
      reason: "stopped",
    });
  });

  it("under the administrator's confirmed basis an opt-in is not needed, but a stop and an erased record always count", () => {
    expect(
      capiConsent("admin_declared", { promotions_opt_in: false, stop_marketing: false }),
    ).toEqual({ ok: true });
    expect(capiConsent("admin_declared", { stop_marketing: true })).toEqual({
      ok: false,
      reason: "stopped",
    });
    expect(capiConsent("admin_declared", { erased_at: "2026-10-01T00:00:00Z" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(capiConsent("admin_declared", { deleted_at: "2026-10-01T00:00:00Z" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(capiConsent("admin_declared", { merged_into_id: "x" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(capiConsent("admin_declared", null)).toEqual({ ok: false, reason: "unavailable" });
    expect(CONSENT_BASIS_PHRASE.length).toBeGreaterThan(20);
  });

  it("keeps an event inside the window that follows the click", () => {
    const click = new Date("2026-10-10T00:00:00Z");
    expect(withinAttributionWindow(click, new Date("2026-10-10T00:00:00Z"), 7)).toBe(true);
    expect(withinAttributionWindow(click, new Date("2026-10-16T23:59:00Z"), 7)).toBe(true);
    expect(withinAttributionWindow(click, new Date("2026-10-17T00:00:00Z"), 7)).toBe(false);
    expect(withinAttributionWindow(click, new Date("2026-10-09T23:59:00Z"), 7)).toBe(false);
  });
});

describe("settings", () => {
  it("defaults to report-only and reads the confirmed basis", () => {
    expect(readCapiConfig({})).toEqual({
      mode: "report_only",
      datasetId: "",
      graphVersion: null,
      testEventCode: null,
      windowDays: 7,
      includePhone: false,
      consentBasis: "contact_opt_in",
      consentBasisAt: null,
    });
    expect(
      readCapiConfig({
        mode: "send_events",
        dataset_id: " 123456 ",
        graph_version: "v22.0",
        test_event_code: "TEST1",
        window_days: 14,
        include_phone: "yes",
        ad_attribution_consent_basis: "admin_declared",
        ad_attribution_consent_basis_at: "2026-10-19T00:00:00Z",
      }),
    ).toMatchObject({
      mode: "send_events",
      datasetId: "123456",
      graphVersion: "v22.0",
      testEventCode: "TEST1",
      windowDays: 14,
      includePhone: true,
      consentBasis: "admin_declared",
    });
    expect(
      readCapiConfig({
        graph_version: "latest",
        window_days: 99,
        ad_attribution_consent_basis: "anything",
      }),
    ).toMatchObject({
      graphVersion: null,
      windowDays: 7,
      consentBasis: "contact_opt_in",
    });
  });

  it("is a data-sharing integration with its own typed words and one secret", () => {
    const d = integrationDef("meta_capi");
    expect(d.sharesData).toBe(true);
    expect(d.contactsPatients).toBe(false);
    expect(d.confirmWord).toBe("SEND AD EVENTS TO META");
    expect(
      allFields("meta_capi", "meta_capi")
        .filter((f) => f.secret)
        .map((f) => f.key),
    ).toEqual(["access_token"]);
  });

  it("validates the dataset id and version, and needs credentials only to send", () => {
    const fields = allFields("meta_capi", "meta_capi");
    expect(validateFields(fields, { dataset_id: "12ab" })).toMatchObject({ ok: false });
    expect(validateFields(fields, { dataset_id: "123456789", graph_version: "21" })).toMatchObject({
      ok: false,
    });
    expect(
      validateFields(fields, {
        mode: "send_events",
        dataset_id: "123456789",
        access_token: "tok",
        graph_version: "v21.0",
      }),
    ).toMatchObject({ ok: true });
    const base = { kind: "meta_capi" as const, provider: "meta_capi", secretsStored: {} };
    expect(readinessProblems({ ...base, config: { mode: "report_only" } })).toEqual([]);
    expect(readinessProblems({ ...base, config: { mode: "send_events" } })).toEqual([
      "Dataset ID is missing.",
      "Access token is missing.",
    ]);
    expect(
      readinessProblems({
        ...base,
        config: { mode: "send_events", dataset_id: "1234567" },
        secretsStored: { access_token: true },
      }),
    ).toEqual([]);
  });
});

describe("referral parsing", () => {
  it("keeps the click id and three ad fields, and nothing else", () => {
    expect(
      parseReferral({
        source_url: "https://fb.me/xyz",
        source_id: "120211234567",
        source_type: "ad",
        headline: "  Free check-up  ",
        body: "ad body text",
        image_url: "https://cdn.test/a.jpg",
        ctwa_clid: " Abc123 ",
      }),
    ).toEqual({
      ctwaClid: "Abc123",
      sourceId: "120211234567",
      sourceType: "ad",
      headline: "Free check-up",
    });
    expect(parseReferral({ source_id: "1" })).toBeNull();
    expect(parseReferral({ ctwa_clid: "has space" })).toBeNull();
    expect(parseReferral({ ctwa_clid: "x".repeat(501) })).toBeNull();
    expect(parseReferral(null)).toBeNull();
    expect(parseReferral([])).toBeNull();
    expect(parseReferral({ ctwa_clid: "ok", headline: "h".repeat(500) })?.headline).toHaveLength(
      200,
    );
  });
});

describe("Conversions API client (recorded fake responses)", () => {
  const payload = buildCapiEvent({
    eventName: "Contact",
    eventId: "evt-0123456789abcdef",
    eventTime: new Date("2026-10-19T08:00:00Z"),
    ctwaClid: "CLID123",
    wabaId: "102290129340398",
  });
  if (!payload.ok) throw new Error("fixture");

  function harness(responses: Array<Response | Error>) {
    const calls: CallRecord[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sleeps: number[] = [];
    let i = 0;
    const client = createCapiClient({
      datasetId: "9988776655",
      accessToken: "EAAB-SECRET-TOKEN",
      graphVersion: "v21.0",
      fetchFn: (async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = responses[Math.min(i++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return next.clone();
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      rng: () => 0.5,
      sink: { record: (c) => void calls.push(c) },
    });
    return { client, calls, requests, sleeps };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("posts the payload to the dataset's events endpoint with a bearer token, and reads events_received", async () => {
    const h = harness([json(200, { events_received: 1, messages: [], fbtrace_id: "A1b2" })]);
    const r = await h.client.sendEvents(payload.payload);
    expect(r).toEqual({ ok: true, eventsReceived: 1 });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe("https://graph.facebook.com/v21.0/9988776655/events");
    const init = h.requests[0].init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer EAAB-SECRET-TOKEN");
    expect(JSON.parse(String(init.body))).toEqual(payload.payload);
    expect(init.redirect).toBe("manual");
    // the token is never in the URL, and the call log holds no token, id or click id
    expect(h.requests[0].url).not.toContain("EAAB");
    expect(JSON.stringify(h.calls)).not.toMatch(/EAAB|CLID123|9988776655/);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      provider: "meta_capi",
      operation: "capi.events",
      outcome: "ok",
      httpStatus: 200,
    });
  });

  it("classifies Graph errors: bad token is an auth failure, throttling is retryable, other 4xx are final", async () => {
    expect(
      await harness([
        json(400, {
          error: {
            message: "Invalid OAuth access token.",
            type: "OAuthException",
            code: 190,
            fbtrace_id: "x",
          },
        }),
      ]).client.sendEvents(payload.payload),
    ).toEqual({ ok: false, code: "graph_190", retryable: false, auth: true });
    expect(
      await harness([json(403, { error: { code: 200 } })]).client.sendEvents(payload.payload),
    ).toEqual({ ok: false, code: "graph_200", retryable: false, auth: true });
    expect(
      await harness([
        json(400, { error: { code: 17, message: "User request limit reached" } }),
      ]).client.sendEvents(payload.payload),
    ).toEqual({ ok: false, code: "graph_17", retryable: true, auth: false });
    expect(
      await harness([
        json(400, { error: { code: 100, message: "Invalid parameter" } }),
      ]).client.sendEvents(payload.payload),
    ).toEqual({ ok: false, code: "graph_100", retryable: false, auth: false });
    expect(await harness([json(404, "nope")]).client.sendEvents(payload.payload)).toEqual({
      ok: false,
      code: "http_404",
      retryable: false,
      auth: false,
    });
  });

  it("treats a 200 that received no event as a failure", async () => {
    expect(
      await harness([json(200, { events_received: 0, messages: ["x"] })]).client.sendEvents(
        payload.payload,
      ),
    ).toEqual({ ok: false, code: "not_received", retryable: false, auth: false });
    expect(await harness([json(200, "not json")]).client.sendEvents(payload.payload)).toMatchObject(
      { ok: false, code: "not_received" },
    );
  });

  it("retries a 5xx and a timeout with back-off (the event id makes a repeat harmless), then succeeds", async () => {
    const h = harness([
      json(503, {}),
      new DOMException("t", "TimeoutError"),
      json(200, { events_received: 1 }),
    ]);
    expect(await h.client.sendEvents(payload.payload)).toEqual({ ok: true, eventsReceived: 1 });
    expect(h.requests).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it("reports a persistent outage as retryable for the queue, and 429 as slow down", async () => {
    const down = harness([json(500, {})]);
    expect(await down.client.sendEvents(payload.payload)).toMatchObject({
      ok: false,
      retryable: true,
      auth: false,
    });
    const limited = harness([json(429, {})]);
    expect(await limited.client.sendEvents(payload.payload)).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryable: true,
    });
  });

  it("verify reads the dataset and never sends an event", async () => {
    const ok = harness([json(200, { id: "9988776655" })]);
    expect(await ok.client.verify()).toEqual({ ok: true });
    expect(ok.requests[0].url).toBe("https://graph.facebook.com/v21.0/9988776655?fields=id");
    expect(ok.requests[0].init?.method).toBe("GET");
    expect(await harness([json(400, { error: { code: 190 } })]).client.verify()).toEqual({
      ok: false,
      code: "auth",
    });
    expect(await harness([json(400, { error: { code: 100 } })]).client.verify()).toEqual({
      ok: false,
      code: "graph_100",
    });
  });

  it("only ever talks to graph.facebook.com", async () => {
    const h = harness([json(200, { events_received: 1 })]);
    await h.client.sendEvents(payload.payload);
    for (const r of h.requests) expect(new URL(r.url).hostname).toBe("graph.facebook.com");
  });

  it("the fake records payloads and can fail on demand", async () => {
    const fake = createFakeCapiClient({
      results: [{ ok: false, code: "graph_17", retryable: true, auth: false }],
    });
    expect(await fake.sendEvents(payload.payload)).toMatchObject({ ok: false });
    expect(await fake.sendEvents(payload.payload)).toEqual({ ok: true, eventsReceived: 1 });
    expect(fake.sent).toHaveLength(2);
  });
});
