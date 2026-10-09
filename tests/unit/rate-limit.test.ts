import { describe, expect, it, vi } from "vitest";

import { checkRateLimit, clientIp, rateKey, RATE_RULES, tooManyRequests, waitText } from "@/lib/rate-limit";

const hdrs = (o: Record<string, string>) => new Headers(o);

describe("clientIp", () => {
  it("prefers the Vercel header, then x-real-ip, then the first forwarded hop", () => {
    expect(clientIp(hdrs({ "x-vercel-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
    expect(clientIp(hdrs({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIp(hdrs({ "x-forwarded-for": "4.4.4.4, 5.5.5.5" }))).toBe("4.4.4.4");
    expect(clientIp(hdrs({}))).toBe("unknown");
  });
});

describe("rateKey", () => {
  it("hashes the id, is stable and case/space-insensitive, and keeps the scope", () => {
    const k = rateKey("login", " Alice@Example.com ");
    expect(k).toBe(rateKey("login", "alice@example.com"));
    expect(k.startsWith("login:")).toBe(true);
    expect(k).not.toContain("alice");
    expect(k.length).toBeLessThanOrEqual(200);
    expect(rateKey("login", "a")).not.toBe(rateKey("export", "a"));
  });
});

function fakeAdmin(result: { data: unknown; error: unknown } | "throw") {
  const rpc = vi.fn(async () => {
    if (result === "throw") throw new Error("network");
    return result;
  });
  return { rpc } as unknown as Parameters<typeof checkRateLimit>[0] & { rpc: typeof rpc };
}

describe("checkRateLimit", () => {
  const rule = { limit: 2, windowSec: 60 };
  it("maps the RPC row", async () => {
    const admin = fakeAdmin({ data: [{ allowed: false, hits: 3, retry_after: 12 }], error: null });
    expect(await checkRateLimit(admin, "x", "id", rule)).toEqual({ allowed: false, hits: 3, retryAfter: 12 });
    expect(admin.rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: rateKey("x", "id"),
      p_limit: 2,
      p_window_seconds: 60,
    });
  });
  it("fails open by default and closed when asked", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await checkRateLimit(fakeAdmin("throw"), "x", "id", rule)).allowed).toBe(true);
    expect((await checkRateLimit(fakeAdmin({ data: null, error: { code: "XX" } }), "x", "id", { ...rule, failOpen: false })).allowed).toBe(false);
    err.mockRestore();
  });
});

describe("responses and rules", () => {
  it("answers 429 with Retry-After", async () => {
    const res = tooManyRequests({ retryAfter: 7 });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.json()).toEqual({ error: "rate_limited", retry_after: 7 });
  });
  it("formats waits", () => {
    expect(waitText(30)).toBe("a minute");
    expect(waitText(600)).toBe("about 10 minutes");
  });
  it("never throttles genuine webhook traffic: only the bad-signature rule exists", () => {
    expect(Object.keys(RATE_RULES).filter((k) => k.startsWith("webhook"))).toEqual(["webhookBadSignature"]);
  });
});
