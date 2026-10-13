/**
 * Circuit breaker for calls to an external provider (pure; the caller supplies the clock and stores the state).
 *
 *   closed     calls go through; consecutive failures are counted
 *   open       after `threshold` failures in a row, calls are refused until `cooldownMs` has passed
 *   half-open  once the cool-down ends the next call is a probe: success closes the breaker, a failure opens it again at once
 *
 * The state is two numbers (consecutive failures and the moment the breaker may close), which is exactly what
 * integration_accounts.consecutive_failures / breaker_open_until persist, so the breaker survives serverless restarts.
 * Only failures that say the PROVIDER is unwell count (timeouts, network errors, 5xx, 429). A 4xx or a bad password is our
 * configuration, not an outage, and never trips the breaker.
 */

export type BreakerState = {
  consecutiveFailures: number;
  /** Epoch ms until which calls are refused; null when the breaker is not open. */
  openUntil: number | null;
};

export type BreakerConfig = { threshold: number; cooldownMs: number };

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, cooldownMs: 5 * 60_000 };

export const CLOSED: BreakerState = { consecutiveFailures: 0, openUntil: null };

export type BreakerStatus = "closed" | "open" | "half_open";

export function breakerStatus(
  state: BreakerState,
  now: number,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): BreakerStatus {
  if (state.openUntil !== null && state.openUntil > now) return "open";
  if (state.consecutiveFailures >= cfg.threshold) return "half_open";
  return "closed";
}

/** May a call be made now? (closed, or a probe once the cool-down has ended.) */
export function canAttempt(
  state: BreakerState,
  now: number,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): boolean {
  return breakerStatus(state, now, cfg) !== "open";
}

export function onSuccess(): BreakerState {
  return CLOSED;
}

export function onFailure(
  state: BreakerState,
  now: number,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): { state: BreakerState; tripped: boolean } {
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= cfg.threshold) {
    return {
      state: { consecutiveFailures, openUntil: now + cfg.cooldownMs },
      tripped: breakerStatus(state, now, cfg) !== "open",
    };
  }
  return { state: { consecutiveFailures, openUntil: null }, tripped: false };
}
