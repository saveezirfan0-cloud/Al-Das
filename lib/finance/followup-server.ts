import "server-only";

import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * The insurance follow-up step of the daily finance_workflows job (Phase 20I). Everything that must be atomic happens in
 * fin_followup_create_tasks (one transaction: the stage claim and its task together, never twice). This wrapper only tells
 * the people who work follow-ups, with a fixed generic sentence and ids (Phase 13 rule: no names, numbers or amounts).
 */

export type FollowupRun = {
  skipped: boolean;
  raised: number;
  tasks: number;
  superseded: number;
  unassigned: number;
  closed: number;
};

export function parseFollowupRun(raw: unknown): FollowupRun {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    skipped: r.skipped === "not_enabled",
    raised: n(r.raised),
    tasks: n(r.tasks),
    superseded: n(r.superseded),
    unassigned: n(r.unassigned),
    closed: n(r.closed),
  };
}

export async function runFollowupTasks(
  admin: AdminClient,
  orgId: string,
  today: string,
  now: Date,
): Promise<FollowupRun> {
  const { data, error } = await admin.rpc("fin_followup_create_tasks", {
    p_org_id: orgId,
    p_today: today,
    p_now: now.toISOString(),
    p_limit: 500,
  });
  if (error) throw new Error("follow-up step failed");
  const run = parseFollowupRun(data);
  if (run.tasks > 0) {
    const firstTask =
      data &&
      typeof data === "object" &&
      typeof (data as { first_task_id?: unknown }).first_task_id === "string"
        ? (data as { first_task_id: string }).first_task_id
        : null;
    await notify(admin, {
      orgId,
      userIds: await memberIdsWithPermission(admin, orgId, "finance.followup.manage"),
      event: "finance.followup_due",
      type: "finance.followup_due",
      title:
        run.tasks === 1
          ? "An unpaid insurance claim needs a follow-up"
          : `${run.tasks} unpaid insurance claims need a follow-up`,
      body: "Open Finance, Insurance follow-up to see which.",
      payload: { count: run.tasks } as NonNullable<Json>,
      ids: { task_id: firstTask },
    });
  }
  return run;
}
