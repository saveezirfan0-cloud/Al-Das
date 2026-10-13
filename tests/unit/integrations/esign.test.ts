import { describe, expect, it } from "vitest";

import {
  allFields,
  integrationDef,
  needsConfirmation,
  validateFields,
} from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { readEsignConfig } from "@/lib/integrations/esign/config";
import {
  createDropboxSignProvider,
  eventHash,
  parseCallback,
  verifyEventHash,
} from "@/lib/integrations/esign/dropbox-sign";
import { createFakeEsignProvider, FAKE_SIGNED_PDF } from "@/lib/integrations/esign/fake";
import {
  deterministicUuid,
  ESIGN_MESSAGE,
  ESIGN_TITLE,
  maskEmail,
  normalizeSignerEmail,
  normalizeSignerName,
} from "@/lib/integrations/esign/signer";
import {
  canMoveEsign,
  ESIGN_STATUSES,
  isFinalEsign,
  outcomeForEvent,
  type EsignStatus,
} from "@/lib/integrations/esign/state";
import { readinessProblems } from "@/lib/integrations/readiness";

describe("request states are forward only", () => {
  it("allows exactly the documented moves", () => {
    const allowed: Array<[EsignStatus, EsignStatus]> = [
      ["creating", "pending"],
      ["creating", "failed"],
      ["pending", "signed"],
      ["pending", "declined"],
      ["pending", "expired"],
      ["pending", "cancelled"],
    ];
    for (const from of ESIGN_STATUSES)
      for (const to of ESIGN_STATUSES)
        expect(canMoveEsign(from, to), `${from} -> ${to}`).toBe(
          allowed.some(([a, b]) => a === from && b === to),
        );
  });

  it("treats signed, declined, expired, cancelled and failed as final", () => {
    for (const s of ["signed", "declined", "expired", "cancelled", "failed"] as const)
      expect(isFinalEsign(s), s).toBe(true);
    expect(isFinalEsign("pending")).toBe(false);
    expect(isFinalEsign("creating")).toBe(false);
  });

  it("maps provider events to outcomes; one signer of several is not done", () => {
    expect(outcomeForEvent("signature_request_all_signed", false)).toBe("signed");
    expect(outcomeForEvent("signature_request_signed", true)).toBe("signed");
    expect(outcomeForEvent("signature_request_signed", false)).toBe("partly_signed");
    expect(outcomeForEvent("signature_request_declined", false)).toBe("declined");
    expect(outcomeForEvent("signature_request_expired", false)).toBe("expired");
    expect(outcomeForEvent("signature_request_canceled", false)).toBe("cancelled");
    for (const other of [
      "signature_request_viewed",
      "signature_request_sent",
      "callback_test",
      "file_error",
      "",
    ])
      expect(outcomeForEvent(other, true), other).toBeNull();
  });
});

describe("signer details", () => {
  it("accepts a plain e-mail and refuses lists, brackets and junk", () => {
    expect(normalizeSignerEmail(" sara@example.com ")).toBe("sara@example.com");
    for (const bad of [
      "",
      "no-at",
      "a@b",
      "a b@c.com",
      "a@b.com, c@d.com",
      "<a@b.com>",
      "a@b.com;c@d.com",
      "x".repeat(250) + "@a.com",
      5,
      null,
    ])
      expect(normalizeSignerEmail(bad), String(bad)).toBeNull();
  });

  it("accepts a name and refuses empty, long or control characters", () => {
    expect(normalizeSignerName("  Sara   Ahmed ")).toBe("Sara Ahmed");
    for (const bad of ["", "   ", "a".repeat(101), "Sara\u0000", "<script>", 5])
      expect(normalizeSignerName(bad), String(bad)).toBeNull();
  });

  it("keeps only a masked hint of the e-mail", () => {
    expect(maskEmail("sara.ahmed@example.com")).toBe("s***@example.com");
    expect(maskEmail("x@y.co")).toBe("x***@y.co");
    expect(maskEmail("nonsense")).toBe("***");
    expect(maskEmail("sara.ahmed@example.com")).not.toContain("ahmed");
  });

  it("derives the same document id from the same request, a different one from another", () => {
    const a = deterministicUuid("esign-signed:11111111-1111-4111-8111-111111111111");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid("esign-signed:11111111-1111-4111-8111-111111111111")).toBe(a);
    expect(deterministicUuid("esign-signed:22222222-2222-4222-8222-222222222222")).not.toBe(a);
  });

  it("sends the provider fixed, generic wording", () => {
    expect(`${ESIGN_TITLE} ${ESIGN_MESSAGE}`).not.toMatch(
      /patient|clinic|diagnos|treatment|surgery|procedure/i,
    );
  });
});

describe("callback event hash", () => {
  it("is HMAC-SHA256 of event time + event type with the API key (test vector)", () => {
    expect(eventHash("key-123", "1348177752", "signature_request_signed")).toBe(
      "2801a808189cdc6171ea800e146e50718a016828d32767bcfdcf8d4faed2cc3e",
    );
  });

  it("verifies a good hash and refuses a wrong key, a changed field, a missing field and a different case of the same hash only when equal", () => {
    const good = {
      event_time: "1348177752",
      event_type: "signature_request_signed",
      event_hash: "2801a808189cdc6171ea800e146e50718a016828d32767bcfdcf8d4faed2cc3e",
    };
    expect(verifyEventHash("key-123", good)).toBe(true);
    expect(verifyEventHash("key-123", { ...good, event_hash: good.event_hash.toUpperCase() })).toBe(
      true,
    );
    expect(verifyEventHash("key-124", good)).toBe(false);
    expect(verifyEventHash("", good)).toBe(false);
    expect(verifyEventHash("key-123", { ...good, event_type: "signature_request_declined" })).toBe(
      false,
    );
    expect(verifyEventHash("key-123", { ...good, event_time: "1348177753" })).toBe(false);
    expect(verifyEventHash("key-123", { ...good, event_hash: "00" })).toBe(false);
    expect(
      verifyEventHash("key-123", { event_type: good.event_type, event_hash: good.event_hash }),
    ).toBe(false);
    expect(verifyEventHash("key-123", { ...good, event_time: 1348177752 })).toBe(true);
  });
});

describe("callback parsing", () => {
  const payload = {
    event: {
      event_time: "1348177752",
      event_type: "signature_request_signed",
      event_hash: "abc",
      event_metadata: { related_signature_id: "s1", reported_for_account_id: "a1" },
    },
    signature_request: {
      signature_request_id: "fa5c8a0b0f492d768749333ad6fcc214c111e967",
      is_complete: true,
      metadata: { pulse_request: "11111111-1111-4111-8111-111111111111" },
      signatures: [],
    },
  };
  const multipart = (json: string) =>
    `--BOUNDARY123\r\nContent-Disposition: form-data; name="json"\r\n\r\n${json}\r\n--BOUNDARY123--\r\n`;
  const expected = {
    eventTime: "1348177752",
    eventType: "signature_request_signed",
    eventHash: "abc",
    requestId: "fa5c8a0b0f492d768749333ad6fcc214c111e967",
    clientRef: "11111111-1111-4111-8111-111111111111",
    isComplete: true,
  };

  it("reads the json field of a multipart/form-data post (how the provider sends events)", () => {
    expect(
      parseCallback(
        multipart(JSON.stringify(payload)),
        "multipart/form-data; boundary=BOUNDARY123",
      ),
    ).toEqual(expected);
    expect(
      parseCallback(
        multipart(JSON.stringify(payload)),
        'multipart/form-data; boundary="BOUNDARY123"',
      ),
    ).toEqual(expected);
  });

  it("also reads a urlencoded post and a bare JSON body", () => {
    expect(
      parseCallback(
        "json=" + encodeURIComponent(JSON.stringify(payload)),
        "application/x-www-form-urlencoded",
      ),
    ).toEqual(expected);
    expect(parseCallback(JSON.stringify(payload), "application/json")).toEqual(expected);
  });

  it("reads a test callback that has no request", () => {
    const test = { event: { event_time: "1", event_type: "callback_test", event_hash: "h" } };
    expect(parseCallback(JSON.stringify(test), "application/json")).toMatchObject({
      eventType: "callback_test",
      requestId: null,
      isComplete: false,
    });
  });

  it("returns null for anything that is not an event", () => {
    for (const [raw, ct] of [
      ["", "application/json"],
      ["not json", "application/json"],
      ["[]", "application/json"],
      [JSON.stringify({ event: { event_time: "1" } }), "application/json"],
      [JSON.stringify({}), "application/json"],
      [multipart("{}"), "multipart/form-data"],
      [multipart("{}"), "multipart/form-data; boundary=OTHER"],
      ["json=", "application/x-www-form-urlencoded"],
    ] as const)
      expect(parseCallback(raw, ct), raw.slice(0, 30)).toBeNull();
  });
});

describe("Dropbox Sign-shaped adapter (recorded fake responses)", () => {
  const req = {
    title: ESIGN_TITLE,
    message: ESIGN_MESSAGE,
    signer: { name: "Sara Ahmed", email: "sara@example.com" },
    fileUrl: "https://storage.example.test/signed-link?token=SECRET",
    expiresAt: new Date("2026-10-26T08:00:00Z"),
    clientRef: "11111111-1111-4111-8111-111111111111",
    testMode: true,
  };
  function harness(responses: Array<Response | Error>) {
    const calls: CallRecord[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    const provider = createDropboxSignProvider({
      apiKey: "DBX-SECRET-KEY",
      fetchFn: (async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = responses[Math.min(i++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return next.clone();
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      rng: () => 0.5,
      sink: { record: (c) => void calls.push(c) },
    })!;
    return { provider, calls, requests };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("creates a signature request with generic wording, the signer and a link to the form, and nothing else", async () => {
    const h = harness([
      json(200, { signature_request: { signature_request_id: "sig-abc", is_complete: false } }),
    ]);
    expect(await h.provider.createRequest(req)).toEqual({ ok: true, providerRequestId: "sig-abc" });
    expect(h.requests[0].url).toBe("https://api.hellosign.com/v3/signature_request/send");
    const init = h.requests[0].init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("DBX-SECRET-KEY:").toString("base64"),
    );
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      test_mode: 1,
      title: "Consent form",
      subject: "Consent form",
      message: "Please review and sign this document.",
      signers: [{ email_address: "sara@example.com", name: "Sara Ahmed", order: 0 }],
      file_urls: ["https://storage.example.test/signed-link?token=SECRET"],
      use_text_tags: true,
      hide_text_tags: true,
      expires_at: 1_793_001_600,
      metadata: { pulse_request: "11111111-1111-4111-8111-111111111111" },
    });
    expect(JSON.stringify(h.calls)).not.toMatch(/DBX|SECRET|sara|example|sig-abc/);
    expect(h.calls[0]).toMatchObject({
      provider: "dropbox_sign",
      operation: "esign.create",
      outcome: "ok",
    });
    const live = harness([json(200, { signature_request: { signature_request_id: "x" } })]);
    await live.provider.createRequest({ ...req, testMode: false });
    expect(JSON.parse(String(live.requests[0].init!.body)).test_mode).toBe(0);
  });

  it("refuses a signer without an e-mail address before calling the provider", async () => {
    const h = harness([json(200, {})]);
    expect(
      await h.provider.createRequest({ ...req, signer: { name: "Sara", phone: "+971501110001" } }),
    ).toEqual({
      ok: false,
      code: "unsupported_signer",
      retryable: false,
      ambiguous: false,
    });
    expect(h.requests).toHaveLength(0);
  });

  it("never sends a create twice: a 5xx or timeout is ambiguous, a bad key or request is final", async () => {
    const down = harness([json(503, {})]);
    expect(await down.provider.createRequest(req)).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: false,
    });
    expect(down.requests).toHaveLength(1);
    const slow = harness([new DOMException("t", "TimeoutError")]);
    expect(await slow.provider.createRequest(req)).toMatchObject({ ok: false, ambiguous: true });
    expect(slow.requests).toHaveLength(1);
    expect(
      await harness([json(401, { error: { error_name: "unauthorized" } })]).provider.createRequest(
        req,
      ),
    ).toEqual({
      ok: false,
      code: "auth",
      retryable: false,
      ambiguous: false,
    });
    expect(
      await harness([
        json(400, { error: { error_name: "bad_request", error_msg: "x" } }),
      ]).provider.createRequest(req),
    ).toEqual({
      ok: false,
      code: "bad_request",
      retryable: false,
      ambiguous: false,
    });
    // a 200 without an id: the provider may have created it
    expect(
      await harness([json(200, { signature_request: {} })]).provider.createRequest(req),
    ).toMatchObject({
      ok: false,
      code: "no_request_id",
      ambiguous: true,
    });
  });

  it("retries a rate limit (nothing was created) and then succeeds", async () => {
    const h = harness([
      json(429, {}),
      json(200, { signature_request: { signature_request_id: "sig-2" } }),
    ]);
    expect(await h.provider.createRequest(req)).toEqual({ ok: true, providerRequestId: "sig-2" });
    expect(h.requests).toHaveLength(2);
  });

  it("cancels a request and refuses an id that is not one of ours", async () => {
    const ok = harness([new Response("", { status: 200 })]);
    expect(await ok.provider.cancelRequest("sig-abc")).toEqual({ ok: true });
    expect(ok.requests[0].url).toBe(
      "https://api.hellosign.com/v3/signature_request/cancel/sig-abc",
    );
    expect(
      await harness([json(410, { error: { error_name: "gone" } })]).provider.cancelRequest(
        "sig-abc",
      ),
    ).toEqual({
      ok: false,
      code: "gone",
    });
    const none = harness([json(200, {})]);
    expect(await none.provider.cancelRequest("../etc")).toEqual({ ok: false, code: "bad_id" });
    expect(none.requests).toHaveLength(0);
  });

  it("fetches the signed PDF as a data URI and decodes it", async () => {
    const b64 = Buffer.from(FAKE_SIGNED_PDF).toString("base64");
    const h = harness([json(200, { data_uri: `data:application/pdf;base64,${b64}` })]);
    const r = await h.provider.fetchSignedPdf("sig-abc");
    expect(r.ok && Buffer.from(r.bytes).equals(Buffer.from(FAKE_SIGNED_PDF))).toBe(true);
    expect(h.requests[0].url).toBe(
      "https://api.hellosign.com/v3/signature_request/files_as_data_uri/sig-abc",
    );
    expect(h.requests[0].init?.method).toBe("GET");
  });

  it("reports a file that is not ready as retryable and anything else as final", async () => {
    expect(
      await harness([json(404, { error: { error_name: "not_found" } })]).provider.fetchSignedPdf(
        "sig-abc",
      ),
    ).toEqual({ ok: false, code: "not_found", retryable: true });
    expect(
      await harness([
        json(200, { data_uri: "data:text/html;base64,PGI+" }),
      ]).provider.fetchSignedPdf("sig-abc"),
    ).toEqual({ ok: false, code: "not_a_pdf", retryable: false });
    expect(
      await harness([json(200, { data_uri: 5 })]).provider.fetchSignedPdf("sig-abc"),
    ).toMatchObject({ ok: false, code: "not_a_pdf" });
    expect(await harness([json(500, {})]).provider.fetchSignedPdf("sig-abc")).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await harness([json(200, {})]).provider.fetchSignedPdf("../x")).toEqual({
      ok: false,
      code: "bad_id",
      retryable: false,
    });
  });

  it("verifies the key with a read-only call, and only talks to api.hellosign.com", async () => {
    const ok = harness([json(200, { account: { account_id: "a" } })]);
    expect(await ok.provider.verify()).toEqual({ ok: true });
    expect(ok.requests[0].url).toBe("https://api.hellosign.com/v3/account");
    expect(await harness([json(401, {})]).provider.verify()).toEqual({ ok: false, code: "auth" });
    await ok.provider.cancelRequest("sig-1");
    for (const r of ok.requests) expect(new URL(r.url).hostname).toBe("api.hellosign.com");
    expect(createDropboxSignProvider({ apiKey: "" })).toBeNull();
  });

  it("the fake records requests and can fail on demand", async () => {
    const f = createFakeEsignProvider({
      create: [{ ok: false, code: "x", retryable: false, ambiguous: false }],
    });
    expect(await f.createRequest(req)).toMatchObject({ ok: false });
    expect(await f.createRequest(req)).toMatchObject({
      ok: true,
      providerRequestId: expect.stringMatching(/^fake-sig-\d+$/),
    });
    expect(f.created).toHaveLength(2);
    expect((await f.fetchSignedPdf("x")).ok).toBe(true);
  });
});

describe("settings", () => {
  it("shares data and contacts patients, so it needs typed words that name the sharing", () => {
    const d = integrationDef("esign");
    expect(d.sharesData).toBe(true);
    expect(d.contactsPatients).toBe(true);
    expect(needsConfirmation("esign")).toBe(true);
    expect(d.confirmWord).toBe("SHARE SIGNER DETAILS AND FORMS");
    expect(d.consequence).toMatch(/third party/);
    expect(d.consequence).toMatch(/name and e-mail/);
    expect(
      allFields("esign", "dropbox_sign")
        .filter((f) => f.secret)
        .map((f) => f.key),
    ).toEqual(["api_key"]);
  });

  it("starts in test mode, and validates the fields", () => {
    const fields = allFields("esign", "dropbox_sign");
    expect(validateFields(fields, { api_key: "k" })).toMatchObject({
      ok: true,
      secrets: { api_key: "k" },
      config: { test_mode: "yes", expiry_days: 7 },
    });
    expect(validateFields(fields, { api_key: "k", expiry_days: 99 })).toMatchObject({ ok: false });
    expect(validateFields(fields, {})).toMatchObject({ ok: false });
    expect(readEsignConfig({})).toEqual({
      provider: "dropbox_sign",
      testMode: true,
      expiryDays: 7,
    });
    expect(readEsignConfig({ test_mode: "no", expiry_days: 14 })).toMatchObject({
      testMode: false,
      expiryDays: 14,
    });
    expect(readEsignConfig({ test_mode: "garbage" }).testMode).toBe(true);
  });

  it("needs patient documents to be switched on", () => {
    const base = {
      kind: "esign" as const,
      provider: "dropbox_sign",
      config: {},
      secretsStored: { api_key: true },
    };
    expect(readinessProblems({ ...base, documentsEnabled: true })).toEqual([]);
    expect(readinessProblems({ ...base, documentsEnabled: false })).toEqual([
      "Switch on patient documents first (Settings, Patient documents).",
    ]);
    expect(readinessProblems(base)).toHaveLength(1);
    expect(readinessProblems({ ...base, secretsStored: {}, documentsEnabled: true })).toEqual([
      "API key is missing.",
    ]);
  });
});
