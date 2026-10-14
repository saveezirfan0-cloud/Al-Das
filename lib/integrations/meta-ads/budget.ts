/**
 * Time budget and fairness of the daily ads insights sync (pure). The job route may run for 60 s (`maxDuration`); a run that is killed
 * records nothing, so the sync must finish well inside it:
 *
 *   - the task stops STARTING workspaces once TASK_DEADLINE_MS has passed (the rest wait for the next run);
 *   - each Graph request gets at most REQUEST_TIMEOUT_MS, one retry, a retry pause of at most MAX_RETRY_SLEEP_MS, and never more than
 *     what is left before the deadline (pageTimeoutMs); with less than MIN_PAGE_BUDGET_MS left no request is started;
 *   - workspaces are taken by their last ATTEMPT (success or failure, oldest first, never tried first), and an attempt is recorded
 *     before the first request, so a workspace that stalls or is cut off moves to the back instead of holding the head of the queue.
 */

export const TASK_DEADLINE_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const REQUEST_MAX_RETRIES = 1;
export const MAX_RETRY_SLEEP_MS = 2_000;
export const MIN_PAGE_BUDGET_MS = 5_000;

/**
 * The timeout for one page request given the time left before the deadline, so that two attempts and one pause fit; null when too
 * little is left to start one.
 */
export function pageTimeoutMs(remainingMs: number): number | null {
  if (!Number.isFinite(remainingMs) || remainingMs < MIN_PAGE_BUDGET_MS) return null;
  const perAttempt = Math.floor((remainingMs - MAX_RETRY_SLEEP_MS) / (REQUEST_MAX_RETRIES + 1));
  return Math.min(REQUEST_TIMEOUT_MS, perAttempt);
}

/** May the task start another workspace? */
export function mayStartWorkspace(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs < TASK_DEADLINE_MS - MIN_PAGE_BUDGET_MS;
}

type Attempted = { org_id: string; last_ok_at: string | null; last_error_at: string | null };

/** The time of the last attempt (the later of the last success and the last failure), or null when never tried. */
export function lastAttemptMs(a: Attempted): number | null {
  const ok = a.last_ok_at ? Date.parse(a.last_ok_at) : NaN;
  const err = a.last_error_at ? Date.parse(a.last_error_at) : NaN;
  const t = Math.max(Number.isNaN(ok) ? -Infinity : ok, Number.isNaN(err) ? -Infinity : err);
  return t === -Infinity ? null : t;
}

/** Never-tried workspaces first, then the one tried longest ago; ties by org id so the order is stable. */
export function orderByLastAttempt<T extends Attempted>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => {
    const a = lastAttemptMs(x);
    const b = lastAttemptMs(y);
    if (a === null && b !== null) return -1;
    if (b === null && a !== null) return 1;
    if (a !== null && b !== null && a !== b) return a - b;
    return x.org_id.localeCompare(y.org_id);
  });
}
