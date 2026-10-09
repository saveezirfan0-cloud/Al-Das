import { describe, expect, it } from "vitest";

import {
  createTokenManager,
  type Http,
  type TokenStore,
  type UniteCredentials,
} from "@/lib/unite/auth";
import type { UniteAuth } from "@/lib/unite/sync-auth";
import {
  createUniteClient,
  extractRecords,
  UniteApiError,
  UniteBreakerOpen,
  UniteNotConfigured,
  uniteDate,
  type BreakerStore,
  type CallLog,
} from "@/lib/unite/sync-client";
import { parseUniteConfig } from "@/lib/unite/config";

const BASE = "https://unite.example.test/gateway/";

type Scripted = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: boolean;
};

/** A fetch that answers from a script and records every request. */
function scriptedFetch(script: Scripted[] | ((url: string, init: RequestInit) => Scripted)) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      auth: headers.get("authorization"),
    });
    const step =
      typeof script === "function"
        ? script(String(url), init)
        : (script[Math.min(i++, script.length - 1)] ?? {});
    if (step.throws) throw new TypeError("network down");
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: step.headers,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (Data: unknown) => ({ body: { Status: "Success", Message: "", Data } });
const fail = (Message: string) => ({ body: { Status: "Exception", Message, Data: "" } });
const tokenReply = (access: string, refresh = "r1", expires = 240) =>
  ok({ access_token: access, refresh_token: refresh, expires_in: expires, token_type: "Bearer" });

const APP = { app_id: "app", app_key: "key" };
const creds = (access: string | undefined, issuedAt: number, refresh = "r1"): UniteCredentials => ({
  authorize: APP,
  refresh: APP,
  access_token: access,
  refresh_token: refresh,
  issued_at: issuedAt,
  ttl_seconds: 240,
});

function memoryStore(initial: UniteCredentials | null = null) {
  let c = initial;
  const store: TokenStore = {
    load: async () => c,
    save: async (n) => {
      c = n;
    },
  };
  return { store, current: () => c };
}

/** The shared token manager (lib/unite/auth.ts) driven by the scripted fetch, as in production. */
function managerAuth(
  store: TokenStore,
  fn: (url: string, init?: RequestInit) => Promise<Response>,
  now: () => number,
) {
  const http: Http = async (req) => {
    const res = await fn(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { status: res.status, text: await res.text() };
  };
  const tokens = createTokenManager({ store, http, baseUrl: BASE, now });
  const auth: UniteAuth = {
    getToken: (o) => (o?.force ? tokens.renewToken() : tokens.getToken()),
  };
  return auth;
}

function memoryBreaker(limit = 5) {
  let failures = 0;
  let open = false;
  const b: BreakerStore = {
    isOpen: async () => open,
    recordSuccess: async () => {
      failures = 0;
    },
    recordFailure: async () => {
      failures++;
      if (failures >= limit) open = true;
      return open;
    },
  };
  return { b, failures: () => failures, isOpen: () => open };
}

function harness(opts: {
  script: Scripted[] | ((u: string, i: RequestInit) => Scripted);
  config?: unknown;
  token?: UniteCredentials | null;
  breaker?: ReturnType<typeof memoryBreaker>;
}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  const now = () => clock;
  const f = scriptedFetch(opts.script);
  const config = parseUniteConfig(opts.config ?? { min_interval_ms: 250 });
  const mem = memoryStore(opts.token === undefined ? creds("tok1", clock) : opts.token);
  const logs: CallLog[] = [];
  const breaker = opts.breaker ?? memoryBreaker();
  const auth = managerAuth(mem.store, f.fn, now);
  const client = createUniteClient({
    baseUrl: BASE,
    config,
    auth,
    breaker: breaker.b,
    fetchFn: f.fn,
    now,
    sleep,
    backoffBaseMs: 500,
    onCall: (c) => {
      logs.push(c);
    },
  });
  return { client, calls: f.calls, sleeps, logs, breaker, mem };
}

describe("uniteDate / extractRecords", () => {
  it("formats DD-MM-YYYY on the clinic clock", () => {
    // 21:30Z on the 11th is already the 12th in Dubai
    expect(uniteDate(new Date("2026-10-11T21:30:00Z"), "Asia/Dubai")).toBe("12-10-2026");
    expect(uniteDate(new Date("2026-10-11T21:30:00Z"), "UTC")).toBe("11-10-2026");
  });

  it("finds the list in any wrapper", () => {
    expect(extractRecords([{ a: 1 }, 3, null])).toEqual([{ a: 1 }]);
    expect(extractRecords({ appointments: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractRecords("")).toEqual([]);
  });
});

describe("read-only client", () => {
  it("GETs the appointments endpoint with the clinic, DD-MM-YYYY dates and a bearer token", async () => {
    const h = harness({ script: [ok([{ appointmentid: "1" }])] });
    const rows = await h.client.getAppointments({
      clinicId: "DHA-F-0000000",
      from: new Date("2026-10-12T05:00:00Z"),
    });
    expect(rows).toEqual([{ appointmentid: "1" }]);
    const url = new URL(h.calls[0].url);
    expect(url.pathname).toBe("/gateway/getallappointments");
    expect(url.searchParams.get("clinic_id")).toBe("DHA-F-0000000");
    expect(url.searchParams.get("from_date")).toBe("12-10-2026");
    expect(url.searchParams.has("to_date")).toBe(false);
    expect(h.calls[0]).toMatchObject({ method: "GET", auth: "Bearer tok1" });
    expect(h.logs).toEqual([
      expect.objectContaining({ endpoint: "getallappointments", outcome: "ok" }),
    ]);
  });

  it("never issues anything but GET on data endpoints", async () => {
    const h = harness({ script: [ok([])] });
    await h.client.getAppointments({ clinicId: "c", from: new Date(), to: new Date() });
    expect(new Set(h.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });

  it("refuses the Finance API and unknown endpoints outright, without a request", async () => {
    const h = harness({
      script: [ok([])],
      config: { paths: { patients: "getfinancedata" } },
    });
    await expect(h.client.listPage("patients")).rejects.toBeInstanceOf(UniteApiError);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses patients / doctors until their endpoint is configured", async () => {
    const h = harness({ script: [ok([])] });
    expect(() => h.client.listPage("doctors")).toThrow(UniteNotConfigured);
  });

  it("keeps a minimum gap between calls", async () => {
    const h = harness({ script: [ok([]), ok([]), ok([])], config: { min_interval_ms: 400 } });
    await h.client.getAppointments({ clinicId: "a", from: new Date() });
    await h.client.getAppointments({ clinicId: "b", from: new Date() });
    await h.client.getAppointments({ clinicId: "c", from: new Date() });
    expect(h.sleeps.filter((s) => s > 0 && s <= 400)).toHaveLength(2);
    expect(Math.min(...h.sleeps)).toBeGreaterThan(0);
  });

  it("runs concurrent callers one at a time, in submission order", async () => {
    const h = harness({ script: () => ok([]) });
    const results = await Promise.all(
      ["1", "2", "3"].map((n) => h.client.getAppointments({ clinicId: n, from: new Date() })),
    );
    expect(results).toHaveLength(3);
    expect(h.calls.map((c) => new URL(c.url).searchParams.get("clinic_id"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    // the throttle spaced them: two gaps of the configured minimum
    expect(h.sleeps.filter((s) => s > 0 && s <= 250)).toHaveLength(2);
  });

  it("backs off exponentially on 5xx and succeeds on a later try", async () => {
    const h = harness({ script: [{ status: 503 }, { status: 502 }, ok([{ appointmentid: "9" }])] });
    const rows = await h.client.getAppointments({ clinicId: "c", from: new Date() });
    expect(rows).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual(expect.arrayContaining([500, 1000]));
    expect(h.breaker.failures()).toBe(0); // success resets the count
    expect(h.logs.map((l) => l.outcome)).toEqual(["error", "error", "ok"]);
  });

  it("honours Retry-After on HTTP 429", async () => {
    const h = harness({ script: [{ status: 429, headers: { "retry-after": "3" } }, ok([])] });
    await h.client.getAppointments({ clinicId: "c", from: new Date() });
    expect(h.sleeps).toContain(3000);
    expect(h.logs[0].outcome).toBe("rate_limited");
  });

  it("retries network failures and then gives up, counting one breaker failure", async () => {
    const h = harness({ script: [{ throws: true }] });
    await expect(h.client.getAppointments({ clinicId: "c", from: new Date() })).rejects.toThrow(
      "Could not reach Unite",
    );
    expect(h.calls).toHaveLength(4); // first try + 3 retries
    expect(h.breaker.failures()).toBe(1);
  });

  it("refreshes the token once when Unite says it expired (HTTP 200 with an error body)", async () => {
    const h = harness({
      script: (url) => {
        if (url.includes("/authorize")) return tokenReply("tok2");
        const call = h?.calls.filter((c) => !c.url.includes("/authorize")).length ?? 0;
        return call <= 1 ? fail("Token Expired") : ok([{ appointmentid: "5" }]);
      },
    });
    const rows = await h.client.getAppointments({ clinicId: "c", from: new Date() });
    expect(rows).toEqual([{ appointmentid: "5" }]);
    const data = h.calls.filter((c) => c.url.includes("getallappointments"));
    expect(data.map((c) => c.auth)).toEqual(["Bearer tok1", "Bearer tok2"]);
    expect(h.mem.current()?.access_token).toBe("tok2");
    expect(h.logs.map((l) => l.outcome)).toEqual(["auth_error", "ok"]);
  });

  it("stops after one forced refresh if the new token is rejected too", async () => {
    const h = harness({
      script: (url) => (url.includes("/authorize") ? tokenReply("tok2") : fail("Invalid Token")),
    });
    await expect(h.client.getAppointments({ clinicId: "c", from: new Date() })).rejects.toThrow(
      /keeps rejecting/,
    );
    expect(h.calls.filter((c) => c.url.includes("getallappointments"))).toHaveLength(2);
  });

  it("treats other vendor errors as final (no retry) and treats 'no records' as empty", async () => {
    const bad = harness({ script: [fail("Clinic not licensed")] });
    await expect(bad.client.getAppointments({ clinicId: "c", from: new Date() })).rejects.toThrow(
      "Clinic not licensed",
    );
    expect(bad.calls).toHaveLength(1);

    const empty = harness({ script: [fail("No Record Found")] });
    expect(await empty.client.getAppointments({ clinicId: "c", from: new Date() })).toEqual([]);
  });

  it("opens the circuit after repeated failures and then makes no calls", async () => {
    const breaker = memoryBreaker(2);
    const h = harness({ script: [fail("boom")], breaker });
    await expect(h.client.getAppointments({ clinicId: "c", from: new Date() })).rejects.toThrow();
    await expect(h.client.getAppointments({ clinicId: "c", from: new Date() })).rejects.toThrow();
    expect(breaker.isOpen()).toBe(true);
    const before = h.calls.length;
    await expect(
      h.client.getAppointments({ clinicId: "c", from: new Date() }),
    ).rejects.toBeInstanceOf(UniteBreakerOpen);
    expect(h.calls.length).toBe(before);
    expect(h.logs.at(-1)?.outcome).toBe("breaker_open");
  });

  it("walks every page of a configured list endpoint", async () => {
    const h = harness({
      config: {
        min_interval_ms: 100,
        paths: { doctors: "getdoctors" },
        paging: { page_param: "page", page_size_param: "size", page_size: 10 },
      },
      script: (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return ok(
          page === 1
            ? Array.from({ length: 10 }, (_, i) => ({ doctor_id: `A${i}` }))
            : [{ doctor_id: "B0" }],
        );
      },
    });
    const rows = await h.client.listAll("doctors");
    expect(rows).toHaveLength(11);
    expect(h.calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(new URL(h.calls[0].url).searchParams.get("size")).toBe("10");
  });
});

describe("token handling (shared token manager)", () => {
  it("never leaks credentials or tokens in an error", async () => {
    const f = scriptedFetch([fail("Invalid credentials")]);
    const store = memoryStore({
      authorize: { app_id: "secret-app", app_key: "secret-key" },
      refresh: { app_id: "secret-app", app_key: "secret-key" },
    });
    const auth = managerAuth(store.store, f.fn, () => 1);
    const err = await auth.getToken().catch((e: Error) => e);
    expect((err as Error).message).toContain("Invalid credentials");
    expect((err as Error).message).not.toMatch(/secret-key|secret-app/);
  });
});
