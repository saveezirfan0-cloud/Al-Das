import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { QueueName } from "@/lib/jobs/queues";
import type { DrainDeps } from "@/lib/jobs/runner";
import type { SchedulerDeps, ScheduledJobRow } from "@/lib/jobs/scheduler";
import type { QueueMessage } from "@/lib/jobs/types";
import type { Json } from "@/lib/supabase/types";

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** Real pgmq/job_runs dependencies for drainQueue(). */
export function dbDrainDeps(admin: AdminClient): DrainDeps {
  return {
    admin,
    read: async (queue, vt, qty) => {
      const rows = must(
        await admin.rpc("job_read", { p_queue: queue, p_vt: vt, p_qty: qty }),
        "job_read",
      );
      return (rows ?? []) as QueueMessage[];
    },
    archive: async (queue, msgIds) => {
      must(await admin.rpc("job_archive", { p_queue: queue, p_msg_ids: msgIds }), "job_archive");
    },
    deadLetter: async (queue, msg, error) => {
      must(
        await admin.rpc("job_dead_letter", {
          p_queue: queue,
          p_msg_id: msg.msg_id,
          p_payload: msg.message,
          p_error: error,
          p_attempts: msg.read_ct,
        }),
        "job_dead_letter",
      );
    },
    startRun: async (queue, handler) => {
      const { data, error } = await admin
        .from("job_runs")
        .insert({ queue, handler })
        .select("id")
        .single();
      if (error) {
        console.error("[jobs] job_runs insert failed", { queue, code: error.code });
        return null;
      }
      return data.id;
    },
    finishRun: async (runId, r) => {
      if (runId == null) return;
      await admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          processed: r.processed,
          failed: r.failed,
          error: r.error ?? null,
          meta: r.meta ?? {},
        })
        .eq("id", runId);
    },
  };
}

/** Real scheduled_jobs dependencies for runScheduler(). */
export function dbSchedulerDeps(admin: AdminClient): SchedulerDeps {
  return {
    claim: async (limit, worker) => {
      const rows = must(
        await admin.rpc("claim_scheduled_jobs", { p_limit: limit, p_worker: worker }),
        "claim_scheduled_jobs",
      );
      return (rows ?? []) as ScheduledJobRow[];
    },
    enqueue: async (queue: QueueName, message: Json) => {
      const id = must(
        await admin.rpc("job_enqueue", { p_queue: queue, p_payload: message, p_delay: 0 }),
        "job_enqueue",
      );
      return Number(id);
    },
    complete: async (id) => {
      must(await admin.rpc("complete_scheduled_job", { p_id: id }), "complete_scheduled_job");
    },
    fail: async (id, error, retryInSeconds) => {
      must(
        await admin.rpc("fail_scheduled_job", {
          p_id: id,
          p_error: error,
          p_retry_in: `${Math.max(0, retryInSeconds)} seconds`,
        }),
        "fail_scheduled_job",
      );
    },
  };
}
