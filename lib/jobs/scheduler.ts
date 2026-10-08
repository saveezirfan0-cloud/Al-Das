/**
 * Scheduler: moves due rows from scheduled_jobs into the right pgmq queue.
 *
 * The claim itself happens in SQL (claim_scheduled_jobs, FOR UPDATE SKIP LOCKED).
 * The pure functions here mirror that selection logic so it can be unit-tested
 * without a database, and decide routing and retry back-off.
 */
import { isQueueName, type QueueName } from "@/lib/jobs/queues";
import type { Json } from "@/lib/supabase/types";

export type ScheduledJobRow = {
  id: string;
  org_id: string | null;
  kind: string;
  payload: Json;
  run_at: string;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  done_at: string | null;
};

export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/** Mirror of the SQL WHERE clause in claim_scheduled_jobs(). */
export function isClaimable(
  job: ScheduledJobRow,
  now: Date,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
): boolean {
  if (job.done_at) return false;
  if (new Date(job.run_at).getTime() > now.getTime()) return false;
  if (job.attempts >= job.max_attempts) return false;
  if (job.locked_at) {
    const lockedAt = new Date(job.locked_at).getTime();
    if (lockedAt >= now.getTime() - lockTtlMs) return false; // lock still fresh
  }
  return true;
}

/** Mirror of claim ordering + limit: earliest run_at first, at most `limit`. */
export function selectClaimable(
  jobs: ScheduledJobRow[],
  now: Date,
  limit: number,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
): ScheduledJobRow[] {
  if (limit <= 0) return [];
  return jobs
    .filter((j) => isClaimable(j, now, lockTtlMs))
    .sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime())
    .slice(0, limit);
}

/** Exponential back-off: 1m, 2m, 4m, 8m… capped at 1h. attempts is the count already made (>= 1). */
export function retryDelaySeconds(attempts: number, baseSeconds = 60, capSeconds = 3600): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(capSeconds, baseSeconds * 2 ** (n - 1));
}

// ---------------------------------------------------------------------------
// Routing: which pgmq queue a scheduled job kind is pushed to.
// ---------------------------------------------------------------------------

const kindRoutes = new Map<string, QueueName>();

/** Register a kind (or a prefix ending in '.*') → queue route. */
export function registerKind(kind: string, queue: QueueName): void {
  kindRoutes.set(kind, queue);
}

export function clearKinds(): void {
  kindRoutes.clear();
}

/**
 * Resolve the queue for a kind:
 *  1. exact registration ('reminder.send' → outbound)
 *  2. prefix registration ('reminder.*' → outbound)
 *  3. 'queue:<name>' convention → that queue
 *  4. otherwise null (the job is failed with a routing error)
 */
export function routeKind(kind: string): QueueName | null {
  const exact = kindRoutes.get(kind);
  if (exact) return exact;
  const parts = kind.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".") + ".*";
    const hit = kindRoutes.get(prefix);
    if (hit) return hit;
  }
  if (kind.startsWith("queue:")) {
    const q = kind.slice("queue:".length);
    if (isQueueName(q)) return q;
  }
  return null;
}

/** The pgmq message produced from a scheduled job. */
export function toQueueMessage(job: ScheduledJobRow): Json {
  return {
    kind: job.kind,
    org_id: job.org_id,
    scheduled_job_id: job.id,
    attempt: job.attempts,
    payload: job.payload,
  };
}

// ---------------------------------------------------------------------------
// Runner (DB-backed). Dependencies are injected so it can be tested in memory.
// ---------------------------------------------------------------------------

export type SchedulerDeps = {
  claim: (limit: number, worker: string) => Promise<ScheduledJobRow[]>;
  enqueue: (queue: QueueName, message: Json) => Promise<number>;
  complete: (id: string) => Promise<void>;
  fail: (id: string, error: string, retryInSeconds: number) => Promise<void>;
};

export type SchedulerResult = {
  claimed: number;
  enqueued: number;
  failed: number;
  errors: string[];
};

export async function runScheduler(
  deps: SchedulerDeps,
  opts: { limit?: number; worker?: string } = {},
): Promise<SchedulerResult> {
  const limit = opts.limit ?? 100;
  const worker = opts.worker ?? `scheduler:${process.pid}`;
  const jobs = await deps.claim(limit, worker);
  const result: SchedulerResult = { claimed: jobs.length, enqueued: 0, failed: 0, errors: [] };

  for (const job of jobs) {
    const queue = routeKind(job.kind);
    if (!queue) {
      // A routing error is permanent: exhaust the attempts so it dead-letters at once.
      result.failed++;
      result.errors.push(`${job.kind}: no route`);
      await deps.fail(job.id, `no queue route for kind "${job.kind}"`, 0);
      continue;
    }
    try {
      await deps.enqueue(queue, toQueueMessage(job));
      await deps.complete(job.id);
      result.enqueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push(`${job.kind}: ${message}`);
      await deps.fail(job.id, message, retryDelaySeconds(job.attempts));
    }
  }
  return result;
}
