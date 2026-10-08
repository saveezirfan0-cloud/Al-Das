import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import type { QueueName } from "@/lib/jobs/queues";

export type JobLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

export type JobContext = {
  queue: QueueName;
  msgId: number;
  /** How many times pgmq has handed this message out (1 on first delivery). */
  readCt: number;
  enqueuedAt: Date;
  admin: AdminClient;
  log: JobLogger;
};

export type JobHandler<P = Json> = (payload: P, ctx: JobContext) => Promise<void>;

export type QueueHandlerDef<P = Json> = {
  queue: QueueName;
  /** Human name shown on the System Health page. */
  name: string;
  handler: JobHandler<P>;
  /** Messages read per drain (default 50). */
  batchSize?: number;
  /** Seconds a message stays hidden while being processed (default 60). */
  visibilityTimeout?: number;
  /** After this many deliveries a failing message is dead-lettered (default 5). */
  maxReads?: number;
  /** Process messages one after another (default) or all at once. */
  concurrency?: "serial" | "parallel";
};

export type QueueMessage = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: Json;
};

export type DrainResult = {
  queue: string;
  runId: number | null;
  read: number;
  processed: number;
  failed: number;
  deadLettered: number;
  durationMs: number;
  error?: string;
};

/** Thrown by a handler to dead-letter the message immediately (bad payload, never retry). */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
