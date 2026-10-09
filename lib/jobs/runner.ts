/**
 * Queue drain: read a batch from pgmq, run the registered handler, archive on
 * success, leave for retry on failure, dead-letter after maxReads. Every drain
 * writes one job_runs row. Dependencies are injected for unit tests.
 */
import { getHandler } from "@/lib/jobs/registry";
import type { QueueName } from "@/lib/jobs/queues";
import { redactMeta, redactText } from "@/lib/redact";
import type {
  DrainResult,
  JobContext,
  JobLogger,
  QueueHandlerDef,
  QueueMessage,
} from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type DrainDeps = {
  read: (queue: QueueName, vt: number, qty: number) => Promise<QueueMessage[]>;
  archive: (queue: QueueName, msgIds: number[]) => Promise<void>;
  deadLetter: (queue: QueueName, msg: QueueMessage, error: string) => Promise<void>;
  startRun: (queue: string, handler: string) => Promise<number | null>;
  finishRun: (
    runId: number | null,
    r: { processed: number; failed: number; error?: string; meta?: Json },
  ) => Promise<void>;
  /** Seconds until the earliest delayed message becomes visible (null = none). Optional. */
  nextDueSeconds?: (queue: QueueName) => Promise<number | null>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  admin: AdminClient;
  log?: JobLogger;
  now?: () => number;
};

export const DEFAULTS = { batchSize: 50, visibilityTimeout: 60, maxReads: 5 } as const;

export function errorMessage(err: unknown): string {
  // Persisted to job_runs / dead_letters: strip tokens, phones and e-mails first (CLAUDE.md rule 9).
  if (err instanceof Error) return redactText(`${err.name}: ${err.message}`, 2000);
  return redactText(String(err), 2000);
}

function isPermanent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { permanent?: boolean }).permanent === true
  );
}

export const consoleLogger: JobLogger = {
  info: (msg, meta) => console.info(`[jobs] ${msg}`, redactMeta(meta) ?? ""),
  warn: (msg, meta) => console.warn(`[jobs] ${msg}`, redactMeta(meta) ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, redactMeta(meta) ?? ""),
};

export async function drainQueue(
  queue: QueueName,
  deps: DrainDeps,
  def: QueueHandlerDef<Json> | undefined = getHandler(queue),
): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? consoleLogger;

  if (!def) {
    return {
      queue,
      runId: null,
      read: 0,
      processed: 0,
      failed: 0,
      deadLettered: 0,
      durationMs: 0,
      error: "no handler registered",
    };
  }

  const batchSize = def.batchSize ?? DEFAULTS.batchSize;
  const vt = def.visibilityTimeout ?? DEFAULTS.visibilityTimeout;
  const maxReads = def.maxReads ?? DEFAULTS.maxReads;

  let messages: QueueMessage[];
  try {
    messages = await deps.read(queue, vt, batchSize);
  } catch (err) {
    const error = errorMessage(err);
    const runId = await deps.startRun(queue, def.name);
    await deps.finishRun(runId, { processed: 0, failed: 0, error });
    return {
      queue,
      runId,
      read: 0,
      processed: 0,
      failed: 0,
      deadLettered: 0,
      durationMs: now() - started,
      error,
    };
  }

  // Nothing to do: don't write an empty job_runs row (cron fires every 10s).
  if (messages.length === 0) {
    return {
      queue,
      runId: null,
      read: 0,
      processed: 0,
      failed: 0,
      deadLettered: 0,
      durationMs: now() - started,
    };
  }

  const runId = await deps.startRun(queue, def.name);
  const done: number[] = [];
  let failed = 0;
  let deadLettered = 0;
  const failures: string[] = [];

  const processOne = async (msg: QueueMessage) => {
    const ctx: JobContext = {
      queue,
      msgId: msg.msg_id,
      readCt: msg.read_ct,
      enqueuedAt: new Date(msg.enqueued_at),
      admin: deps.admin,
      log,
    };
    try {
      await def.handler(msg.message, ctx);
      done.push(msg.msg_id);
    } catch (err) {
      failed++;
      const error = errorMessage(err);
      failures.push(error);
      if (isPermanent(err) || msg.read_ct >= maxReads) {
        try {
          await deps.deadLetter(queue, msg, error);
          deadLettered++;
        } catch (dlErr) {
          log.error("dead-letter failed", { queue, msgId: msg.msg_id, error: errorMessage(dlErr) });
        }
      } else {
        // Leave the message: it becomes visible again after the visibility timeout.
        log.warn("job failed; will retry", {
          queue,
          msgId: msg.msg_id,
          readCt: msg.read_ct,
          error,
        });
      }
    }
  };

  if (def.concurrency === "parallel") {
    await Promise.all(messages.map(processOne));
  } else {
    for (const msg of messages) await processOne(msg);
  }

  let archiveError: string | undefined;
  if (done.length > 0) {
    try {
      await deps.archive(queue, done);
    } catch (err) {
      archiveError = errorMessage(err);
      log.error("archive failed; messages will be redelivered", {
        queue,
        count: done.length,
        error: archiveError,
      });
    }
  }

  const error = archiveError ?? (failures.length > 0 ? failures[0] : undefined);
  await deps.finishRun(runId, {
    processed: done.length,
    failed,
    error,
    meta: { read: messages.length, deadLettered, failures: failures.slice(0, 5) },
  });

  return {
    queue,
    runId,
    read: messages.length,
    processed: done.length,
    failed,
    deadLettered,
    durationMs: now() - started,
    error,
  };
}

export type DrainLoopOptions = {
  /** Stop starting new batches once this much time has passed (route maxDuration is 60 s). */
  budgetMs?: number;
  maxBatches?: number;
};

export type DrainLoopResult = DrainResult & { batches: number };

export const DRAIN_LOOP_DEFAULTS = { budgetMs: 40_000, maxBatches: 200 } as const;

/**
 * One cron tick used to read a single batch, which caps throughput at
 * batchSize / tick (50 per 10 s for meta_events ≈ 300/min). This keeps draining
 * batches until the queue is empty, a batch fully fails (no hot-looping on poison
 * messages), or the time budget is spent. When the queue is idle but delayed messages are
 * due within the budget it waits for them rather than returning. Overlapping ticks are safe: pgmq.read
 * hides messages for the visibility timeout, and handlers are idempotent.
 */
export async function drainQueueUntilIdle(
  queue: QueueName,
  deps: DrainDeps,
  opts: DrainLoopOptions = {},
  def: QueueHandlerDef<Json> | undefined = getHandler(queue),
): Promise<DrainLoopResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budgetMs = opts.budgetMs ?? DRAIN_LOOP_DEFAULTS.budgetMs;
  const maxBatches = opts.maxBatches ?? DRAIN_LOOP_DEFAULTS.maxBatches;

  const total: DrainLoopResult = {
    queue,
    runId: null,
    read: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    durationMs: 0,
    batches: 0,
  };

  let waits = 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  while (total.batches < maxBatches) {
    const r = await drainQueue(queue, deps, def);
    if (r.read === 0 && !r.error) {
      // Idle now, but delayed messages (reserved bulk sends) may fall due within the budget:
      // wait for them here so they go out on time and evenly, not in a clump at the next tick.
      const due = deps.nextDueSeconds ? await deps.nextDueSeconds(queue) : null;
      if (due == null) break;
      const waitMs = Math.max(250, due * 1000 + 50);
      if (now() - started + waitMs >= budgetMs || ++waits > 1000) break;
      await sleep(waitMs);
      continue;
    }
    total.batches++;
    total.runId ??= r.runId;
    total.read += r.read;
    total.processed += r.processed;
    total.failed += r.failed;
    total.deadLettered += r.deadLettered;
    if (r.error) total.error = r.error;
    if (r.read === 0) break; // read itself failed: report it, don't retry in a tight loop
    if (r.processed === 0) break; // whole batch failed: leave it to the visibility timeout
    if (now() - started >= budgetMs) break;
  }
  total.durationMs = now() - started;
  return total;
}
