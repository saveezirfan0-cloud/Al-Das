import { registerTask } from "@/lib/jobs/tasks";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { scheduleReminder } from "@/lib/tasks/service";

/**
 * /api/jobs/tasks_daily (pg_cron hourly at :07): the daily opening and closing checklists per branch (Phase F).
 *
 * Per organisation with active templates, public.task_generate_checklists() makes one task per template and local day
 * once the template's generate time has passed in the branch's timezone, with the template's lines as its checklist.
 * The unique occurrence key makes a retry, an overlapping run or a second hourly run a no-op. Each new task gets its
 * due reminder. Counts only are logged.
 */
registerTask("tasks_daily", {
  name: "tasks.daily",
  run: (admin, log) => runTasksDaily(admin, log),
});

export type TasksDailyTotals = { orgs: number; created: number; failed_orgs: number };

export async function runTasksDaily(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<TasksDailyTotals> {
  const totals: TasksDailyTotals = { orgs: 0, created: 0, failed_orgs: 0 };
  const { data: templates } = await fetchAll<{ id: string; org_id: string }>((from, to) =>
    admin
      .from("task_checklist_templates")
      .select("id, org_id")
      .eq("active", true)
      .order("id")
      .range(from, to),
  );
  const orgIds = [...new Set((templates ?? []).map((t) => t.org_id))];
  for (const orgId of orgIds) {
    totals.orgs++;
    const { data, error } = await admin.rpc("task_generate_checklists", {
      p_org_id: orgId,
      p_now: now.toISOString(),
    });
    if (error) {
      totals.failed_orgs++;
      log.warn("checklist generation failed", { code: error.code ?? null });
      continue;
    }
    const ids = (data ?? []).map((r: { task_id: string }) => r.task_id);
    totals.created += ids.length;
    if (ids.length === 0) continue;
    const { data: created } = await admin
      .from("tasks")
      .select("id, due_at, done")
      .eq("org_id", orgId)
      .in("id", ids);
    for (const t of created ?? []) await scheduleReminder({ admin, orgId, userId: null }, t);
  }
  log.info("tasks daily done", totals);
  return totals;
}
