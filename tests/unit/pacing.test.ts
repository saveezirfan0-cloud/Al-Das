import { describe, expect, it } from "vitest";

import { MAX_SLOT_WAIT_MS, slotRetryDelaySeconds, slotWaitExpired } from "@/lib/jobs/pacing";
import { graphBaseUrl } from "@/lib/whatsapp/channel";

describe("slotRetryDelaySeconds", () => {
  it("starts at about a second and backs off to a 10 s base", () => {
    expect(slotRetryDelaySeconds(0, () => 0)).toBe(1);
    expect(slotRetryDelaySeconds(5, () => 0)).toBe(2);
    expect(slotRetryDelaySeconds(30, () => 0)).toBe(7);
    expect(slotRetryDelaySeconds(10_000, () => 0)).toBe(10);
  });
  it("adds jitter of at most half the base so a backlog spreads out", () => {
    for (const attempt of [0, 7, 40, 500]) {
      const lo = slotRetryDelaySeconds(attempt, () => 0);
      const hi = slotRetryDelaySeconds(attempt, () => 0.999);
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(hi - lo).toBeLessThanOrEqual(Math.ceil(lo / 2));
    }
  });
  it("tolerates a negative attempt", () => {
    expect(slotRetryDelaySeconds(-3, () => 0)).toBe(1);
  });
});

describe("slotWaitExpired", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  it("expires by message age, not attempts (a 20k campaign at 20 msg/s takes ~17 minutes)", () => {
    expect(slotWaitExpired(new Date(now - 17 * 60_000).toISOString(), now)).toBe(false);
    expect(slotWaitExpired(new Date(now - MAX_SLOT_WAIT_MS - 1000).toISOString(), now)).toBe(true);
  });
  it("never expires a message with no or an unparseable timestamp", () => {
    expect(slotWaitExpired(null, now)).toBe(false);
    expect(slotWaitExpired("not a date", now)).toBe(false);
  });
});

describe("graphBaseUrl", () => {
  it("honours loopback http only, so the token cannot be redirected off-box", () => {
    expect(graphBaseUrl("http://127.0.0.1:4010")).toBe("http://127.0.0.1:4010");
    expect(graphBaseUrl("http://localhost:4010/anything")).toBe("http://localhost:4010");
    expect(graphBaseUrl("https://evil.example.com")).toBeUndefined();
    expect(graphBaseUrl("http://evil.example.com")).toBeUndefined();
    expect(graphBaseUrl("http://127.0.0.1.evil.com")).toBeUndefined();
    expect(graphBaseUrl("nonsense")).toBeUndefined();
    expect(graphBaseUrl(undefined)).toBeUndefined();
  });
});

describe("bulkSlotCap", () => {
  it("leaves headroom for live chat", async () => {
    const { bulkSlotCap } = await import("@/lib/jobs/pacing");
    expect(bulkSlotCap(20)).toBe(16);
    expect(bulkSlotCap(80)).toBe(64);
    expect(bulkSlotCap(1)).toBe(1);
    expect(bulkSlotCap(3)).toBe(2);
  });
});
