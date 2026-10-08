/**
 * Queue drain: read a batch from pgmq, run the registered handler, archive on
 * success, leave for retry on failure, dead-letter after maxReads. Every drain
 * writes one job_runs row. Dependencies are injected for unit tests.
 */
import { getHandler } from "@/lib/jobs/registry";
import type { QueueName } from "@/lib/jobs/queues";
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
  admin: AdminClient;
  log?: JobLogger;
  now?: () => number;
};

export const DEFAULTS = { batchSize: 50, visibilityTimeout: 60, maxReads: 5 } as const;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 2000);
  return String(err).slice(0, 2000);
}

function isPermanent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { permanent?: boolean }).permanent === true
  );
}

export const consoleLogger: JobLogger = {
  info: (msg, meta) => console.info(`[jobs] ${msg}`, meta ?? ""),
  warn: (msg, meta) => console.warn(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
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
