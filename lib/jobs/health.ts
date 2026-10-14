import "server-only";

import { listHandlers } from "@/lib/jobs/registry";
import { QUEUES } from "@/lib/jobs/queues";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export type QueueHealth = {
  queue: string;
  depth: number | null;
  oldestAgeSec: number | null;
  total: number | null;
  handler: string | null;
  /** Latest job_runs row for this queue. */
  lastRun: Pick<
    Tables<"job_runs">,
    "started_at" | "finished_at" | "processed" | "failed" | "error"
  > | null;
  status: "ok" | "idle" | "backlog" | "failing" | "no_handler" | "unknown";
};

export type SystemHealth = {
  queues: QueueHealth[];
  recentRuns: Tables<"job_runs">[];
  deadLetters: Tables<"dead_letters">[];
  scheduled: { pending: number; overdue: number; locked: number };
  cron: Array<{
    jobname: string;
    schedule: string;
    active: boolean;
    last_status: string | null;
    last_start: string | null;
    last_end: string | null;
  }>;
  cronAvailable: boolean;
  metricsError: string | null;
};

export const BACKLOG_THRESHOLD = 500;
export const OLDEST_AGE_THRESHOLD_SEC = 300;

export function classifyQueue(q: Omit<QueueHealth, "status">): QueueHealth["status"] {
  if (!q.handler) return "no_handler";
  if (q.depth == null) return "unknown";
  if (q.lastRun?.error && (q.lastRun.failed ?? 0) > 0 && (q.lastRun.processed ?? 0) === 0)
    return "failing";
  if (q.depth >= BACKLOG_THRESHOLD || (q.oldestAgeSec ?? 0) >= OLDEST_AGE_THRESHOLD_SEC)
    return "backlog";
  if (q.depth === 0 && !q.lastRun) return "idle";
  return "ok";
}

/** Not-yet-done scheduled jobs, as an exact-count head request (no rows). */
function scheduledCount(admin: AdminClient) {
  return admin
    .from("scheduled_jobs")
    .select("id", { count: "exact", head: true })
    .is("done_at", null);
}

export async function getSystemHealth(admin: AdminClient): Promise<SystemHealth> {
  const handlers = new Map(listHandlers().map((h) => [h.queue, h.name]));

  const [metricsRes, runsRes, dlRes, schedRes, cronRes] = await Promise.all([
    admin.rpc("job_queue_metrics"),
    admin.from("job_runs").select("*").order("started_at", { ascending: false }).limit(50),
    admin
      .from("dead_letters")
      .select("*")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(100),
    // Exact counts (PostgREST returns at most 1,000 rows, so counting fetched rows reads low on a backlog).
    Promise.all([
      scheduledCount(admin),
      scheduledCount(admin)
        .lt("run_at", new Date(Date.now() - 60_000).toISOString())
        .is("locked_at", null),
      scheduledCount(admin).not("locked_at", "is", null),
    ]).then((res) => res.map((r) => r.count ?? 0)),
    admin.rpc("job_cron_status"),
  ]);

  const metrics = new Map((metricsRes.data ?? []).map((m) => [m.queue_name, m]));
  const recentRuns = runsRes.data ?? [];
  const lastRunByQueue = new Map<string, Tables<"job_runs">>();
  for (const r of recentRuns) if (!lastRunByQueue.has(r.queue)) lastRunByQueue.set(r.queue, r);

  const queues: QueueHealth[] = QUEUES.map((queue) => {
    const m = metrics.get(queue);
    const lastRun = lastRunByQueue.get(queue) ?? null;
    const base = {
      queue,
      depth: m ? Number(m.queue_length) : null,
      oldestAgeSec: m?.oldest_msg_age_sec ?? null,
      total: m ? Number(m.total_messages) : null,
      handler: handlers.get(queue) ?? null,
      lastRun: lastRun
        ? {
            started_at: lastRun.started_at,
            finished_at: lastRun.finished_at,
            processed: lastRun.processed,
            failed: lastRun.failed,
            error: lastRun.error,
          }
        : null,
    };
    return { ...base, status: classifyQueue(base) };
  });

  const [pending, overdue, locked] = schedRes;
  const scheduled = { pending, overdue, locked };

  return {
    queues,
    recentRuns,
    deadLetters: dlRes.data ?? [],
    scheduled,
    cron: cronRes.error ? [] : (cronRes.data ?? []),
    cronAvailable: !cronRes.error,
    metricsError: metricsRes.error?.message ?? null,
  };
}
