import { describe, expect, it } from "vitest";

import { CLOSED, type BreakerState } from "@/lib/integrations/breaker";
import {
  checkUrl,
  createIntegrationClient,
  IntegrationError,
  outcomeForStatus,
  type BreakerStore,
  type CallRecord,
} from "@/lib/integrations/client";

const HOSTS = ["api.example-sms.test"];
const URL_OK = "https://api.example-sms.test/v1/send?token=SECRETTOKEN";

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function harness(
  responses: Array<Response | Error>,
  opts: { breaker?: BreakerStore; maxRetries?: number } = {},
) {
  const calls: CallRecord[] = [];
  const sleeps: number[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let clock = 1_000;
  let i = 0;
  const client = createIntegrationClient({
    provider: "test",
    allowedHosts: HOSTS,
    fetchFn: (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      clock += 25;
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next.clone();
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => void sleeps.push(ms),
    rng: () => 0.5,
    sink: { record: (c) => void calls.push(c) },
    breaker: opts.breaker,
    maxRetries: opts.maxRetries,
  });
  return { client, calls, sleeps, requests };
}

describe("url guard", () => {
  it("allows only https on listed hosts without credentials", () => {
    expect(checkUrl(URL_OK, HOSTS)).not.toBeNull();
    expect(checkUrl("http://api.example-sms.test/x", HOSTS)).toBeNull();
    expect(checkUrl("https://evil.test/x", HOSTS)).toBeNull();
    expect(checkUrl("https://api.example-sms.test.evil.test/x", HOSTS)).toBeNull();
    expect(checkUrl("https://user:pw@api.example-sms.test/x", HOSTS)).toBeNull();
    expect(checkUrl("https://127.0.0.1/x", HOSTS)).toBeNull();
    expect(checkUrl("not a url", HOSTS)).toBeNull();
  });

  it("refuses a blocked URL without calling fetch, and logs it", async () => {
    const h = harness([res(200)]);
    await expect(
      h.client.request({ operation: "op", method: "GET", url: "https://evil.test/" }),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(h.requests).toHaveLength(0);
    expect(h.calls).toEqual([
      {
        provider: "test",
        operation: "op",
        outcome: "blocked",
        httpStatus: null,
        durationMs: 0,
        attempt: 1,
      },
    ]);
  });
});

describe("outcomes", () => {
  it("classifies statuses", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(401)).toBe("auth_error");
    expect(outcomeForStatus(404)).toBe("client_error");
    expect(outcomeForStatus(429)).toBe("rate_limited");
    expect(outcomeForStatus(503)).toBe("server_error");
  });
});

describe("requests", () => {
  it("returns a 4xx to the caller instead of throwing, parsed", async () => {
    const h = harness([res(400, { code: 21211 })]);
    const r = await h.client.request({ operation: "op", method: "POST", url: URL_OK, body: "a=1" });
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
    expect(r.json).toEqual({ code: 21211 });
    expect(h.requests).toHaveLength(1);
  });

  it("retries an idempotent request on 503 with back-off and then succeeds", async () => {
    const h = harness([res(503), res(502), res(200, { ok: true })]);
    const r = await h.client.request({ operation: "op", method: "GET", url: URL_OK });
    expect(r.json).toEqual({ ok: true });
    expect(h.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([375, 750]); // rng 0.5 -> 3/4 of the ceiling (500, 1000)
    expect(h.calls.map((c) => [c.outcome, c.attempt])).toEqual([
      ["server_error", 1],
      ["server_error", 2],
      ["ok", 3],
    ]);
  });

  it("gives up after the retries and throws a retryable error", async () => {
    const h = harness([res(500)], { maxRetries: 2 });
    const err = await h.client
      .request({ operation: "op", method: "GET", url: URL_OK })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ kind: "server_error", status: 500, retryable: true });
    expect(h.requests).toHaveLength(3);
  });

  it("does NOT retry a non-idempotent POST after a 5xx or a timeout: the outcome is ambiguous", async () => {
    const h = harness([res(503)]);
    const err = await h.client
      .request({ operation: "send", method: "POST", url: URL_OK, body: "x" })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "server_error", ambiguous: true });
    expect(h.requests).toHaveLength(1);

    const t = harness([Object.assign(new Error("aborted"), { name: "TimeoutError" })]);
    const terr = await t.client
      .request({ operation: "send", method: "POST", url: URL_OK, body: "x" })
      .catch((e) => e);
    expect(terr).toMatchObject({ kind: "timeout", ambiguous: true });
    expect(t.requests).toHaveLength(1);
  });

  it("does retry a non-idempotent POST after a 429 (the provider did not process it) and honours Retry-After", async () => {
    const h = harness([res(429, {}, { "retry-after": "2" }), res(201, { sid: "x" })]);
    const r = await h.client.request({ operation: "send", method: "POST", url: URL_OK, body: "x" });
    expect(r.status).toBe(201);
    expect(h.sleeps).toEqual([2000]);
  });

  it("retries an idempotent POST (idempotency key) on a timeout", async () => {
    const h = harness([Object.assign(new Error("t"), { name: "AbortError" }), res(200, { id: 1 })]);
    const r = await h.client.request({
      operation: "pay",
      method: "POST",
      url: URL_OK,
      body: "x",
      idempotent: true,
    });
    expect(r.status).toBe(200);
    expect(h.calls.map((c) => c.outcome)).toEqual(["timeout", "ok"]);
  });

  it("caps the response size", async () => {
    const h = harness([res(200, "x".repeat(2_000_000))]);
    await expect(
      h.client.request({ operation: "op", method: "GET", url: URL_OK }),
    ).rejects.toMatchObject({ kind: "response_too_large" });
  });

  it("never writes a URL, token, header or body into the call log or an error message", async () => {
    const h = harness([res(500)], { maxRetries: 1 });
    const err = await h.client
      .request({
        operation: "sms.send",
        method: "POST",
        url: URL_OK,
        headers: { Authorization: "Bearer SECRETBEARER" },
        body: "To=%2B971500000000&Body=PRIVATEMESSAGE",
        idempotent: true,
      })
      .catch((e: unknown) => e);
    const dump = JSON.stringify(h.calls) + String((err as Error).message);
    for (const secret of [
      "SECRETTOKEN",
      "SECRETBEARER",
      "PRIVATEMESSAGE",
      "971500000000",
      "api.example-sms.test",
    ])
      expect(dump).not.toContain(secret);
    expect(Object.keys(h.calls[0]).sort()).toEqual([
      "attempt",
      "durationMs",
      "httpStatus",
      "operation",
      "outcome",
      "provider",
    ]);
  });

  it("a failing sink never breaks the call", async () => {
    const client = createIntegrationClient({
      provider: "t",
      allowedHosts: HOSTS,
      fetchFn: (async () => res(200)) as unknown as typeof fetch,
      sink: { record: () => Promise.reject(new Error("db down")) },
    });
    await expect(
      client.request({ operation: "op", method: "GET", url: URL_OK }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("circuit breaker around the client", () => {
  function memoryBreaker(initial: BreakerState = CLOSED) {
    let state = initial;
    const store: BreakerStore = {
      load: async () => state,
      save: async (s) => void (state = s),
    };
    return { store, get: () => state };
  }

  it("opens after repeated provider failures, then refuses without calling the provider", async () => {
    const b = memoryBreaker();
    const h = harness([res(500)], { breaker: b.store, maxRetries: 0 });
    for (let i = 0; i < 5; i++)
      await h.client
        .request({ operation: "op", method: "GET", url: URL_OK })
        .catch(() => undefined);
    expect(b.get().openUntil).not.toBeNull();
    const before = h.requests.length;
    const err = await h.client
      .request({ operation: "op", method: "GET", url: URL_OK })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "breaker_open", retryable: true });
    expect(h.requests.length).toBe(before);
    expect(h.calls.at(-1)?.outcome).toBe("breaker_open");
  });

  it("a 4xx (our fault, not an outage) does not count and a success resets the count", async () => {
    const b = memoryBreaker({ consecutiveFailures: 3, openUntil: null });
    const h = harness([res(400)], { breaker: b.store });
    await h.client.request({ operation: "op", method: "POST", url: URL_OK, body: "x" });
    expect(b.get()).toEqual(CLOSED);
  });

  it("an unreadable breaker store does not stop calls", async () => {
    const store: BreakerStore = {
      load: () => Promise.reject(new Error("x")),
      save: () => Promise.resolve(),
    };
    const h = harness([res(200)], { breaker: store });
    await expect(
      h.client.request({ operation: "op", method: "GET", url: URL_OK }),
    ).resolves.toMatchObject({ status: 200 });
  });
});
