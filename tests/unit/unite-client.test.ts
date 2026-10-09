import { describe, expect, it } from "vitest";

import {
  createTokenManager,
  TOKEN_SAFETY_MARGIN_MS,
  UniteAuthError,
  type Http,
  type HttpRequest,
  type TokenStore,
  type UniteCredentials,
} from "@/lib/unite/auth";
import { createUniteClient, UniteCallError } from "@/lib/unite/client";

const BASE = "https://unite.test/gateway/";
const creds = (over: Partial<UniteCredentials> = {}): UniteCredentials => ({
  authorize: { app_id: "AUTH-ID", app_key: "AUTH-KEY-SECRET" },
  refresh: { app_id: "REF-ID", app_key: "REF-KEY-SECRET" },
  ...over,
});
const ok = (access: string, refresh = "R2", expires_in = 240) =>
  JSON.stringify({
    Status: "Success",
    Message: "",
    Data: { access_token: access, refresh_token: refresh, expires_in },
  });
const fail = (message: string) =>
  JSON.stringify({ Data: "", Status: "Exception", Message: message });

function setup(
  initial: UniteCredentials | null,
  responses: Array<string | Error>,
  startAt = 1_000_000,
) {
  let clock = startAt;
  let saved = initial;
  const requests: HttpRequest[] = [];
  const queue = [...responses];
  const store: TokenStore = {
    load: async () => saved,
    save: async (c) => {
      saved = c;
    },
  };
  const http: Http = async (req) => {
    requests.push(req);
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected extra http call");
    if (next instanceof Error) throw next;
    return { status: 200, text: next }; // Unite answers HTTP 200 even on failure
  };
  const now = () => clock;
  const tokens = createTokenManager({ store, http, baseUrl: BASE, now });
  const client = createUniteClient({ tokens, http, baseUrl: BASE, now });
  return { tokens, client, requests, advance: (ms: number) => (clock += ms), saved: () => saved };
}

describe("token manager", () => {
  it("reuses a valid token without calling Unite", async () => {
    const t = setup(
      creds({ access_token: "A1", refresh_token: "R1", issued_at: 1_000_000, ttl_seconds: 240 }),
      [],
    );
    expect(await t.tokens.getToken()).toBe("A1");
    expect(t.requests).toHaveLength(0);
  });

  it("authorizes when no token is stored, without a bearer header, then caches", async () => {
    const t = setup(creds(), [ok("A1")]);
    expect(await t.tokens.getToken()).toBe("A1");
    expect(t.requests[0].method).toBe("GET");
    expect(t.requests[0].url).toBe(`${BASE}authorize?app_id=AUTH-ID&app_key=AUTH-KEY-SECRET`);
    expect(t.requests[0].headers).toEqual({});
    expect(await t.tokens.getToken()).toBe("A1");
    expect(t.requests).toHaveLength(1);
  });

  it("re-authorizes with the current access token as bearer once it is within the safety margin", async () => {
    const t = setup(
      creds({ access_token: "A1", refresh_token: "R1", issued_at: 1_000_000, ttl_seconds: 240 }),
      [ok("A2")],
    );
    t.advance(240_000 - TOKEN_SAFETY_MARGIN_MS); // exactly at the margin: no longer valid
    expect(await t.tokens.getToken()).toBe("A2");
    expect(t.requests[0].headers).toEqual({ Authorization: "Bearer A1" });
  });

  it("treats expires_in as seconds and never trusts more than 240", async () => {
    const t = setup(creds(), [ok("A1", "R1", 14_400)]);
    await t.tokens.getToken();
    expect(t.saved()?.ttl_seconds).toBe(240);
  });

  it("refreshes with the refresh pair when authorize says Token Expired", async () => {
    const t = setup(creds({ access_token: "A1", refresh_token: "R1", issued_at: 0 }), [
      fail("Token Expired"),
      ok("A2", "R2"),
    ]);
    expect(await t.tokens.getToken()).toBe("A2");
    const refresh = t.requests[1];
    expect(refresh.method).toBe("POST");
    expect(refresh.url).toBe(`${BASE}refreshtoken`);
    expect(refresh.headers?.Authorization).toBe("Bearer R1");
    expect(JSON.parse(refresh.body as string)).toEqual({
      app_id: "REF-ID",
      app_key: "REF-KEY-SECRET",
      token: "A1",
    });
    expect(t.saved()).toMatchObject({ access_token: "A2", refresh_token: "R2" });
  });

  it("fails clearly, without leaking keys or tokens, when authorize and refresh both fail", async () => {
    const t = setup(creds({ access_token: "A1-TOKEN", refresh_token: "R1-TOKEN", issued_at: 0 }), [
      fail("Token Expired"),
      fail("Invalid Token"),
    ]);
    const err = await t.tokens.getToken().catch((e) => e as Error);
    expect(err).toBeInstanceOf(UniteAuthError);
    for (const secret of ["AUTH-KEY-SECRET", "REF-KEY-SECRET", "A1-TOKEN", "R1-TOKEN"])
      expect((err as Error).message).not.toContain(secret);
  });

  it("errors when nothing is configured or a refresh token is missing", async () => {
    await expect(setup(null, []).tokens.getToken()).rejects.toThrow(/no Unite credentials/);
    await expect(
      setup(creds({ access_token: "A1", issued_at: 0 }), [fail("Token Expired")]).tokens.getToken(),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe("finance client", () => {
  const valid = () =>
    creds({ access_token: "A1", refresh_token: "R1", issued_at: 1_000_000, ttl_seconds: 240 });
  const req = { fromDate: "01-01-2026", toDate: "09-10-2026", count: 50 };
  const data = JSON.stringify({
    MessageStatus: "Success",
    DataBalancetoSync: 3,
    Data: [{ InvDisplayNumber: "X" }],
  });

  it("posts the documented request and returns the body untouched", async () => {
    const t = setup(valid(), [data]);
    const res = await t.client.financeDetails(req);
    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual(JSON.parse(data));
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({
      method: "POST",
      url: `${BASE}GetFinanceDetails`,
      headers: { Authorization: "Bearer A1" },
    });
    expect(JSON.parse(t.requests[0].body as string)).toEqual(req);
  });

  it("retries exactly once with a fresh token when the body says the token was rejected", async () => {
    const t = setup(valid(), [fail("Token Expired"), ok("A2"), data]);
    const res = await t.client.financeDetails(req);
    expect((res.body as { Data: unknown[] }).Data).toHaveLength(1);
    expect(t.requests.filter((r) => r.url.endsWith("GetFinanceDetails"))).toHaveLength(2);
    expect(t.requests[2].headers?.Authorization).toBe("Bearer A2");
  });

  it("does not loop when the token is rejected twice", async () => {
    const t = setup(valid(), [fail("Token Expired"), ok("A2"), fail("Token Expired")]);
    const res = await t.client.financeDetails(req);
    expect((res.body as { Message: string }).Message).toBe("Token Expired");
    expect(t.requests.filter((r) => r.url.endsWith("GetFinanceDetails"))).toHaveLength(2);
  });

  it("never retries after a transport failure: records may already be consumed", async () => {
    const t = setup(valid(), [new Error("socket hang up")]);
    await expect(t.client.financeDetails(req)).rejects.toBeInstanceOf(UniteCallError);
    expect(t.requests).toHaveLength(1);
  });

  it("returns an unparseable response as text so the caller can still store it", async () => {
    const t = setup(valid(), ["<html>502</html>"]);
    const res = await t.client.financeDetails(req);
    expect(res.body).toEqual({ _unparseable: true, text: "<html>502</html>" });
  });

  it("is blocked from the real host by the test guard", () => {
    expect(() =>
      fetch("https://ucexternalapiprod.uniteuae.care/gateway/GetFinanceDetails"),
    ).toThrow(/never call the real Unite API/);
  });
});
