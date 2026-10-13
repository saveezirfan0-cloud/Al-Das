/**
 * Retry timing for integration calls (pure; the random source and the clock are parameters so tests are deterministic).
 * Exponential back-off with "equal jitter": half of the ceiling is certain, the other half is random, so many workers that
 * failed together do not retry together and a retry is never immediate.
 */

export type BackoffOptions = {
  /** Ceiling of the first retry's delay. */
  baseMs: number;
  /** No delay is ever longer than this. */
  maxMs: number;
  factor?: number;
};

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 8_000, factor: 2 };

/** Delay before retry number `retry` (1 = the first retry). */
export function backoffDelayMs(
  retry: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const factor = opts.factor ?? 2;
  const ceiling = Math.min(opts.maxMs, opts.baseMs * Math.pow(factor, Math.max(0, retry - 1)));
  const r = Math.min(1, Math.max(0, rng()));
  return Math.round(ceiling / 2 + (ceiling / 2) * r);
}

/**
 * A Retry-After header: whole seconds or an HTTP date. Returns milliseconds from now, capped at `maxMs`
 * (a provider cannot make a request handler wait for minutes), or null when absent or unreadable.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
  maxMs = 10_000,
): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(maxMs, Number(value) * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.min(maxMs, Math.max(0, when - nowMs));
}
