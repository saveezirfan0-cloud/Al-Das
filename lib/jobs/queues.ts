/** pgmq queue names. Must match supabase/migrations/*_queues.sql. */
export const QUEUES = [
  "meta_events",
  "outbound",
  "outbound_priority",
  "campaign_fanout",
  "flow_steps",
  "media_fetch",
  "webhooks_out",
  "unite_sync",
  "finance_capture",
  "kb_ingest",
  "notifications",
  "appointments",
] as const;

export type QueueName = (typeof QUEUES)[number];

/** Pseudo-queue drained by /api/jobs/scheduler: moves due scheduled_jobs into pgmq. */
export const SCHEDULER_QUEUE = "scheduler";

export function isQueueName(value: string): value is QueueName {
  return (QUEUES as readonly string[]).includes(value);
}
