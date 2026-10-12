import { describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/usage";

/** A fake rpc("rate_limit_hit") whose answer depends on which bucket was hit. */
function admin(answers: Record<string, { allowed: boolean; hits?: number; retry_after?: number }>) {
  const calls: Array<{ limit: number; window: number }> = [];
  const rpc = vi.fn(async (_fn: string, args: { p_key: string; p_limit: number; p_window_seconds: number }) => {
    calls.push({ limit: args.p_limit, window: args.p_window_seconds });
    const kind = args.p_window_seconds === 60 ? "minute" : "day";
    const a = answers[kind] ?? { allowed: true };
    return { data: [{ allowed: a.allowed, hits: a.hits ?? 1, retry_after: a.retry_after ?? 0 }], error: null };
  });
  return { admin: { rpc } as never, calls, rpc };
}

describe("AI rate limit", () => {
  it("counts atomically through rate_limit_hit, per user per minute and per workspace per day", async () => {
    const { admin: a, calls } = admin({});
    expect(await checkRateLimit(a, "org", "user", 10, 500)).toEqual({ allowed: true });
    expect(calls).toEqual([
      { limit: 10, window: 60 },
      { limit: 500, window: 86_400 },
    ]);
  });

  it("says which limit was hit, and skips the daily count when the minute limit already refused", async () => {
    const minute = admin({ minute: { allowed: false } });
    expect(await checkRateLimit(minute.admin, "org", "user", 10, 500)).toEqual({ allowed: false, reason: "minute" });
    expect(minute.calls).toHaveLength(1);
    const day = admin({ day: { allowed: false } });
    expect(await checkRateLimit(day.admin, "org", "user", 10, 500)).toEqual({ allowed: false, reason: "daily" });
  });

  it("a daily cap of 0 means no cap, and a counter failure fails open", async () => {
    const off = admin({});
    await checkRateLimit(off.admin, "org", "user", 10, 0);
    expect(off.calls).toHaveLength(1);
    const broken = { rpc: async () => ({ data: null, error: { code: "XX" } }) } as never;
    expect((await checkRateLimit(broken, "org", "user", 10, 500)).allowed).toBe(true);
  });

  it("never puts the user or org id in clear in the bucket key", async () => {
    const { admin: a, rpc } = admin({});
    await checkRateLimit(a, "11111111-aaaa", "22222222-bbbb", 10, 500);
    for (const call of rpc.mock.calls) expect(JSON.stringify(call)).not.toMatch(/11111111|22222222/);
  });
});
