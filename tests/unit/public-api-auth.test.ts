import { describe, expect, it, vi } from "vitest";

import { authenticateApiKey, requireScope, setRateLimiter } from "@/lib/public-api/auth";
import { generateApiKey } from "@/lib/public-api/keys";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

const NOW = new Date("2026-03-01T12:00:00Z");

function setup(row: Partial<Record<string, unknown>> = {}) {
  const { key, hash } = generateApiKey();
  const admin = createFakeAdmin({
    api_keys: [
      { id: "k1", org_id: "org1", key_hash: hash, scopes: ["contacts:read"], expires_at: null, revoked_at: null, last_used_at: null, ...row },
    ],
  });
  const request = (headers: Record<string, string> = { Authorization: `Bearer ${key}` }) => new Request("https://x.test/api/public/v1/contacts", { headers });
  return { key, admin, as: admin as unknown as AdminClient, request };
}

async function bodyOf(res: Response) {
  return (await res.json()) as { error: { code: string } };
}

describe("authenticateApiKey", () => {
  it("accepts a valid key and returns the org and scopes", async () => {
    const { as, request } = setup();
    const r = await authenticateApiKey(request(), as, NOW);
    expect(r).toEqual({ ok: true, ctx: { keyId: "k1", orgId: "org1", scopes: ["contacts:read"] } });
  });

  it.each([
    ["no header", {}, "missing_api_key"],
    ["wrong scheme", { Authorization: "Basic abc" }, "missing_api_key"],
    ["malformed key", { Authorization: "Bearer nope" }, "invalid_api_key"],
    ["well-formed but unknown key", { Authorization: `Bearer ${generateApiKey().key}` }, "invalid_api_key"],
  ])("rejects %s with 401 %s", async (_name, headers, code) => {
    const { as, request } = setup();
    const r = await authenticateApiKey(request(headers as Record<string, string>), as, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toMatch(/Bearer/);
      expect((await bodyOf(r.response)).error.code).toBe(code);
    }
  });

  it("rejects revoked and expired keys, but only reveals why after the hash matched", async () => {
    const revoked = setup({ revoked_at: "2026-02-01T00:00:00Z" });
    const r1 = await authenticateApiKey(revoked.request(), revoked.as, NOW);
    expect(!r1.ok && (await bodyOf(r1.response)).error.code).toBe("api_key_revoked");

    const expired = setup({ expires_at: "2026-02-28T00:00:00Z" });
    const r2 = await authenticateApiKey(expired.request(), expired.as, NOW);
    expect(!r2.ok && (await bodyOf(r2.response)).error.code).toBe("api_key_expired");

    const future = setup({ expires_at: "2026-12-31T00:00:00Z" });
    expect((await authenticateApiKey(future.request(), future.as, NOW)).ok).toBe(true);
  });

  it("throttles last_used_at writes to once per five minutes", async () => {
    const { admin, as, request } = setup();
    await authenticateApiKey(request(), as, NOW);
    const writes = () => admin._calls.filter((c) => c.table === "api_keys" && c.op === "update").length;
    expect(writes()).toBe(1);
    expect(admin._rows("api_keys")[0].last_used_at).toBe(NOW.toISOString());

    await authenticateApiKey(request(), as, new Date(NOW.getTime() + 60_000)); // 1 min later
    expect(writes()).toBe(1);
    await authenticateApiKey(request(), as, new Date(NOW.getTime() + 6 * 60_000)); // 6 min later
    expect(writes()).toBe(2);
  });

  it("applies the rate limiter hook and answers 429 with Retry-After", async () => {
    const { as, request } = setup();
    setRateLimiter(async () => ({ allowed: false, retryAfterSeconds: 7 }));
    try {
      const r = await authenticateApiKey(request(), as, NOW);
      expect(!r.ok && r.response.status).toBe(429);
      expect(!r.ok && r.response.headers.get("Retry-After")).toBe("7");
    } finally {
      setRateLimiter(async () => ({ allowed: true }));
    }
  });

  it("never echoes the key in a response", async () => {
    const { key, as } = setup();
    const r = await authenticateApiKey(new Request("https://x.test", { headers: { Authorization: `Bearer ${key.slice(0, -1)}x` } }), as, NOW);
    expect(JSON.stringify(!r.ok && (await r.response.clone().text()))).not.toContain(key.slice(10, 30));
  });
});

describe("requireScope", () => {
  it("returns null when allowed and a 403 when not", async () => {
    const ctx = { keyId: "k", orgId: "o", scopes: ["contacts:read"] };
    expect(requireScope(ctx, "contacts:read")).toBeNull();
    const denied = requireScope(ctx, "messages:send_template");
    expect(denied?.status).toBe(403);
    expect((await bodyOf(denied!)).error.code).toBe("insufficient_scope");
  });
});

void vi;
