import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_AGE_BASIS,
  DEFAULT_BUCKET_DAYS,
  DEFAULT_STAGE_DAYS,
  validDaySteps,
  type FollowupAgeBasis,
} from "@/lib/finance/followup";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database, Tables } from "@/lib/supabase/types";

/** The Phase 20I settings on fin_ref_finance_settings: ageing buckets and the follow-up stages (default 120 days). */

export type FollowupSettings = {
  bucketDays: number[];
  stageDays: number[];
  /** What follow-up counts from: the submission date (default) or the visit date. */
  ageBasis: FollowupAgeBasis;
  /** null = the daily job raises no follow-up tasks */
  startDate: string | null;
  taskEnabled: boolean;
  taskRole: string;
  taskDueDays: number;
};

export const DEFAULT_FOLLOWUP_SETTINGS: FollowupSettings = {
  bucketDays: [...DEFAULT_BUCKET_DAYS],
  stageDays: [...DEFAULT_STAGE_DAYS],
  ageBasis: DEFAULT_AGE_BASIS,
  startDate: null,
  taskEnabled: true,
  taskRole: "Insurance",
  taskDueDays: 3,
};

export function followupFromRow(r: Tables<"fin_ref_finance_settings"> | null): FollowupSettings {
  const d = DEFAULT_FOLLOWUP_SETTINGS;
  if (!r) return d;
  return {
    bucketDays: validDaySteps(r.ageing_bucket_days ?? [], 8) ? r.ageing_bucket_days : d.bucketDays,
    stageDays: validDaySteps(r.followup_stage_days ?? [], 6) ? r.followup_stage_days : d.stageDays,
    ageBasis: r.followup_age_basis === "visit" ? "visit" : "submission",
    startDate: r.followup_start_date,
    taskEnabled: r.followup_task_enabled,
    taskRole: r.followup_task_role || d.taskRole,
    taskDueDays: Number.isFinite(Number(r.followup_task_due_days))
      ? Number(r.followup_task_due_days)
      : d.taskDueDays,
  };
}

export async function loadFollowupSettings(
  client: AdminClient | SupabaseClient<Database>,
  orgId: string,
): Promise<FollowupSettings> {
  const { data } = await client
    .from("fin_ref_finance_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  return followupFromRow(data);
}
