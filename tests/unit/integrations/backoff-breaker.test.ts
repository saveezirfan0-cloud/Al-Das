import { describe, expect, it } from "vitest";

import { backoffDelayMs, parseRetryAfterMs } from "@/lib/integrations/backoff";
import {
  CLOSED,
  breakerStatus,
  canAttempt,
  onFailure,
  onSuccess,
  type BreakerConfig,
  type BreakerState,
} from "@/lib/integrations/breaker";

describe("backoff", () => {
  const opts = { baseMs: 500, maxMs: 8000, factor: 2 };

  it("grows exponentially and keeps half the ceiling as a floor", () => {
    expect(backoffDelayMs(1, opts, () => 0)).toBe(250);
    expect(backoffDelayMs(1, opts, () => 1)).toBe(500);
    expect(backoffDelayMs(2, opts, () => 0)).toBe(500);
    expect(backoffDelayMs(3, opts, () => 1)).toBe(2000);
  });

  it("never exceeds the cap, however many retries", () => {
    for (const retry of [5, 10, 40]) expect(backoffDelayMs(retry, opts, () => 1)).toBe(8000);
  });

  it("jitters: different random values give different delays within [ceiling/2, ceiling]", () => {
    const a = backoffDelayMs(3, opts, () => 0.1);
    const b = backoffDelayMs(3, opts, () => 0.9);
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThanOrEqual(1000);
    expect(b).toBeLessThanOrEqual(2000);
  });

  it("tolerates a bad random source", () => {
    expect(backoffDelayMs(1, opts, () => 5)).toBe(500);
    expect(backoffDelayMs(1, opts, () => -3)).toBe(250);
  });

  it("reads Retry-After as seconds or an HTTP date, capped", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    expect(parseRetryAfterMs("3", now)).toBe(3000);
    expect(parseRetryAfterMs("999", now)).toBe(10_000);
    expect(parseRetryAfterMs("Sun, 18 Oct 2026 10:00:02 GMT", now)).toBe(2000);
    expect(parseRetryAfterMs("Sun, 18 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });
});

describe("circuit breaker (fake clock)", () => {
  const cfg: BreakerConfig = { threshold: 3, cooldownMs: 60_000 };
  const t = 1_000_000;

  it("stays closed below the threshold and a success resets the count", () => {
    let s: BreakerState = CLOSED;
    s = onFailure(s, t, cfg).state;
    s = onFailure(s, t, cfg).state;
    expect(breakerStatus(s, t, cfg)).toBe("closed");
    expect(canAttempt(s, t, cfg)).toBe(true);
    s = onSuccess();
    expect(s).toEqual(CLOSED);
  });

  it("opens at the threshold, refuses calls during the cool-down and reports the trip once", () => {
    let s: BreakerState = CLOSED;
    s = onFailure(s, t, cfg).state;
    s = onFailure(s, t, cfg).state;
    const third = onFailure(s, t, cfg);
    expect(third.tripped).toBe(true);
    expect(breakerStatus(third.state, t, cfg)).toBe("open");
    expect(canAttempt(third.state, t + 59_999, cfg)).toBe(false);
    // a straggler failing while already open does not "trip" again
    expect(onFailure(third.state, t + 10, cfg).tripped).toBe(false);
  });

  it("lets one probe through after the cool-down: success closes it, failure re-opens it at once", () => {
    let s: BreakerState = CLOSED;
    for (let i = 0; i < 3; i++) s = onFailure(s, t, cfg).state;
    const later = t + 60_001;
    expect(breakerStatus(s, later, cfg)).toBe("half_open");
    expect(canAttempt(s, later, cfg)).toBe(true);
    expect(onSuccess()).toEqual(CLOSED);
    const failed = onFailure(s, later, cfg);
    expect(failed.tripped).toBe(true);
    expect(breakerStatus(failed.state, later, cfg)).toBe("open");
    expect(failed.state.openUntil).toBe(later + 60_000);
  });
});
