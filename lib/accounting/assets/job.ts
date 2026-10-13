import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { loadCloseCalendar } from "@/lib/finance/close-timetable-server";
import { workingDay } from "@/lib/finance/close-timetable";
import type { JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";

import { addMonths, monthStart } from "./depreciation";
import { prepareRun } from "./server";
import { RUN_KINDS } from "./runs";

/**
 * /api/jobs/accounting_assets (pg_cron daily 04:25 UTC), Phase 22H. Short, idempotent, logged to job_runs by the task
 * runner. For each organisation:
 *
 *   1. Posts the automatic reversals that are due (acc_run_auto_reversals, 22A; the reversing accruals rely on it).
 *      Idempotent: a reversed journal is never picked again.
 *   2. On or after the first working day of the month (the finance close calendar: weekend days and holidays), prepares
 *      last month's depreciation, schedule and reversing-accrual runs for every active entity, once: a month that
 *      already has a run of that kind is left alone (people re-run it themselves). It NEVER posts: a person with
 *      accounting.journals.approve does that.
 *   3. When it prepared something, notifies the people who manage assets with a fixed generic sentence (no amounts).
 *
 * Counts only are logged; a failure is logged by name and never stops the other organisations or steps.
 */

export type AssetJobTotals = {
  orgs: number;
  runs_prepared: number;
  runs_empty: number;
  runs_skipped: number;
  runs_refused: number;
  auto_reversed: number;
  auto_reversal_failed: number;
  notified: number;
};

export async function runAccountingAssetsJob(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<AssetJobTotals> {
  const totals: AssetJobTotals = {
    orgs: 0,
    runs_prepared: 0,
    runs_empty: 0,
    runs_skipped: 0,
    runs_refused: 0,
    auto_reversed: 0,
    auto_reversal_failed: 0,
    notified: 0,
  };
  const { data: orgs } = await admin.from("orgs").select("id, timezone");
  for (const org of orgs ?? []) {
    totals.orgs++;
    try {
      await oneOrg(admin, org, now, totals, log);
    } catch (err) {
      log.error("accounting assets job failed for an organisation", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  log.info("accounting assets job done", totals);
  return totals;
}

async function oneOrg(
  admin: AdminClient,
  org: { id: string; timezone: string | null },
  now: Date,
  totals: AssetJobTotals,
  log: JobLogger,
) {
  const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");

  const { data: rev, error: revErr } = await admin.rpc("acc_run_auto_reversals", {
    p_org_id: org.id,
    p_today: today,
  });
  if (revErr)
    log.error("automatic reversals failed for an organisation", { code: revErr.code ?? "error" });
  else {
    const r = rev as { done?: unknown[]; failed?: unknown[] } | null;
    totals.auto_reversed += r?.done?.length ?? 0;
    totals.auto_reversal_failed += r?.failed?.length ?? 0;
  }

  const cal = await loadCloseCalendar(admin, org.id);
  const month = monthStart(today)!;
  const wd1 = workingDay(month, 1, cal);
  if (!wd1 || today < wd1) return;
  const prev = addMonths(month, -1);

  const { data: entities } = await admin
    .from("acc_entities")
    .select("id")
    .eq("org_id", org.id)
    .eq("active", true);
  let prepared = 0;
  for (const e of entities ?? []) {
    const { data: existing } = await admin
      .from("acc_depreciation_runs")
      .select("kind")
      .eq("org_id", org.id)
      .eq("entity_id", e.id)
      .eq("period_month", prev);
    const done = new Set((existing ?? []).map((r) => r.kind));
    for (const kind of RUN_KINDS) {
      if (done.has(kind)) {
        totals.runs_skipped++;
        continue;
      }
      try {
        const res = await prepareRun(admin, {
          orgId: org.id,
          entityId: e.id,
          kind,
          month: prev,
          userId: null,
          skipEmpty: true,
        });
        if (!res) totals.runs_empty++;
        else if (res.changed) {
          totals.runs_prepared++;
          prepared++;
        }
      } catch (err) {
        const hint = (err as { hint?: string } | null)?.hint;
        if (hint === "later_month_posted") totals.runs_refused++;
        else
          log.error("a run could not be prepared", {
            kind,
            code: hint ?? (err instanceof Error ? err.name : "error"),
          });
      }
    }
  }
  if (prepared > 0) {
    const userIds = await memberIdsWithPermission(admin, org.id, "accounting.assets.manage");
    if (userIds.length > 0) {
      await notify(admin, {
        orgId: org.id,
        userIds,
        event: "accounting.runs_prepared",
        type: "accounting.runs_prepared",
        title: "Month-end depreciation and schedule runs are ready",
        body: "Open Accounting, Depreciation and Schedules to review them. Someone with journal approval posts them.",
        payload: { count: prepared },
      });
      totals.notified += userIds.length;
    }
  }
}
