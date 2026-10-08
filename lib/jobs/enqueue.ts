import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { QueueName } from "@/lib/jobs/queues";
import type { Json } from "@/lib/supabase/types";

/** Push a message onto a pgmq queue. Returns the pgmq msg_id. */
export async function enqueue(
  queue: QueueName,
  payload: Json,
  opts: { delaySeconds?: number } = {},
): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("job_enqueue", {
    p_queue: queue,
    p_payload: payload,
    p_delay: Math.max(0, Math.floor(opts.delaySeconds ?? 0)),
  });
  if (error) throw new Error(`enqueue(${queue}) failed: ${error.message}`);
  return Number(data);
}

export type ScheduleOptions = {
  kind: string;
  payload?: Json;
  runAt: Date;
  orgId?: string | null;
  /** One pending job per key; a duplicate schedule is ignored. */
  dedupeKey?: string;
  maxAttempts?: number;
};

/** Schedule work for later (reminders, flow waits, retries). Picked up by /api/jobs/scheduler. */
export async function scheduleJob(
  opts: ScheduleOptions,
): Promise<{ id: string | null; deduped: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("scheduled_jobs")
    .insert({
      kind: opts.kind,
      payload: opts.payload ?? {},
      run_at: opts.runAt.toISOString(),
      org_id: opts.orgId ?? null,
      dedupe_key: opts.dedupeKey ?? null,
      max_attempts: opts.maxAttempts ?? 5,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505" && opts.dedupeKey) return { id: null, deduped: true };
    throw new Error(`scheduleJob(${opts.kind}) failed: ${error.message}`);
  }
  return { id: data.id, deduped: false };
}
