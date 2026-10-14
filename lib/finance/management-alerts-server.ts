import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { loadDoctorPerformance } from "@/lib/finance/doctor-performance-server";
import { previousMonthPeriod } from "@/lib/finance/flash";
import { loadLines, loadTargets } from "@/lib/finance/flash-server";
import {
  alertTransitions,
  bandBelowMessage,
  doctorsBelowBand,
  MGMT_ALERT_EVENTS,
  mgmtAlertSettingsFromRow,
  parseMgmtAlertInputs,
  reportIsLate,
  reportLateMessage,
  revenueBehindMessage,
  revenueBehindScopes,
  revenueProgress,
  type AlertKey,
  type MgmtAlertRule,
  type MgmtAlertSettings,
} from "@/lib/finance/management-alerts";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Runs the M1 management alerts for one organisation (called once a day from lib/finance/workflows.ts). Reads the
 * Unite collection report aggregates (fin_mgmt_alert_inputs, amounts and codes only), the flash lines and targets, and
 * last month's doctor performance; decides with the pure rules in management-alerts.ts; claims each new alert in SQL
 * (fin_mgmt_alert_claim) and only then notifies, so a retry never notifies twice. Service role; no caller input.
 *
 * Recipients, by permission (as every finance reminder picks them, memberIdsWithPermission; the finance access window
 * applies when they open the page):
 *   report_late     finance.revenue.import (who uploads the report)
 *   revenue_behind  finance.flash.view (the flash report is not branch-bound)
 *   band_below      finance.revenue.view, members who see every branch only: the count covers all branches and the
 *                   doctor performance page is branch-bound
 */

const PERMISSION: Record<MgmtAlertRule, string> = {
  report_late: "finance.revenue.import",
  revenue_behind: "finance.flash.view",
  band_below: "finance.revenue.view",
};

export type MgmtAlertTotals = { raised: number; cleared: number; notified: number; failed: number };

type Org = { id: string; timezone: string | null };

async function loadSettings(admin: AdminClient, orgId: string): Promise<MgmtAlertSettings> {
  const { data, error } = await admin
    .from("fin_ref_finance_settings")
    .select(
      "alert_report_late_days, alert_revenue_target_pct, alert_revenue_target_days, alert_band_min_patients",
    )
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error("management alert settings unreadable");
  return mgmtAlertSettingsFromRow(data);
}

async function recipients(admin: AdminClient, orgId: string, rule: MgmtAlertRule) {
  const ids = await memberIdsWithPermission(admin, orgId, PERMISSION[rule]);
  if (rule !== "band_below" || ids.length === 0) return ids;
  const { data } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .eq("branch_scope", "all")
    .in("user_id", ids);
  return (data ?? []).map((m) => m.user_id);
}

export async function runManagementAlerts(
  admin: AdminClient,
  org: Org,
  now: Date = new Date(),
): Promise<MgmtAlertTotals> {
  const totals: MgmtAlertTotals = { raised: 0, cleared: 0, notified: 0, failed: 0 };
  const settings = await loadSettings(admin, org.id);
  const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");
  const month = `${today.slice(0, 7)}-01`;
  const active: AlertKey[] = [];
  const evaluated = new Set<MgmtAlertRule>();
  let revenueScopes: string[] = [];
  let bandCount = 0;
  const lastMonth = previousMonthPeriod(today)?.month ?? null;

  // Rules 1 and 2 share the current month's inputs.
  try {
    const [res, lines, targets] = await Promise.all([
      admin.rpc("fin_mgmt_alert_inputs", { p_org_id: org.id, p_month: month }),
      loadLines(admin, org.id),
      loadTargets(admin, org.id, month),
    ]);
    if (res.error) throw new Error("management alert inputs unreadable");
    const inputs = parseMgmtAlertInputs(res.data);
    if (reportIsLate({ today, lastCovered: inputs.lastCovered, lateDays: settings.reportLateDays }))
      active.push({ rule: "report_late", scope: "all", period: "-" });
    evaluated.add("report_late");

    revenueScopes = revenueBehindScopes(
      revenueProgress({ month, rows: inputs.rows, lines, targets, coverage: inputs.coverage }),
      settings.revenueTargetPct,
      settings.revenueTargetDays,
    );
    for (const scope of revenueScopes)
      active.push({ rule: "revenue_behind", scope, period: month.slice(0, 7) });
    evaluated.add("revenue_behind");
  } catch {
    totals.failed++;
  }

  // Rule 3: last month, once fully covered (all branches).
  if (lastMonth) {
    try {
      const report = await loadDoctorPerformance(admin, org.id, {
        month: lastMonth,
        branch: null,
        allowed: null,
      });
      const n = doctorsBelowBand(report, settings.bandMinPatients);
      if (n !== null && n > 0) {
        bandCount = n;
        active.push({ rule: "band_below", scope: "all", period: lastMonth.slice(0, 7) });
      }
      evaluated.add("band_below");
    } catch {
      totals.failed++;
    }
  }

  const { data: openRows, error: openError } = await admin
    .from("fin_mgmt_alert_state")
    .select("rule, scope, period")
    .eq("org_id", org.id)
    .is("cleared_at", null);
  if (openError) throw new Error("management alert state unreadable");
  const open = (openRows ?? []) as AlertKey[];
  const { raise, clear } = alertTransitions(active, open, evaluated);

  const won: AlertKey[] = [];
  for (const k of raise) {
    const { data, error } = await admin.rpc("fin_mgmt_alert_claim", {
      p_org_id: org.id,
      p_rule: k.rule,
      p_scope: k.scope,
      p_period: k.period,
    });
    if (error)
      totals.failed++; // not claimed: tried again tomorrow; the keys already won are still announced
    else if (data === true) won.push(k);
  }
  totals.raised = won.length;

  const at = now.toISOString();
  for (const k of clear) {
    const { data } = await admin
      .from("fin_mgmt_alert_state")
      .update({ cleared_at: at })
      .eq("org_id", org.id)
      .eq("rule", k.rule)
      .eq("scope", k.scope)
      .eq("period", k.period)
      .is("cleared_at", null)
      .select("rule");
    totals.cleared += (data ?? []).length;
  }

  // One notification per rule and run; the claim above guarantees nothing is announced twice.
  for (const rule of new Set(won.map((k) => k.rule))) {
    const keys = won.filter((k) => k.rule === rule);
    const period = keys[0].period;
    const msg =
      rule === "report_late"
        ? reportLateMessage(settings.reportLateDays)
        : rule === "revenue_behind"
          ? revenueBehindMessage(
              revenueScopes.filter((s) => keys.some((k) => k.scope === s)),
              settings,
            )
          : bandBelowMessage(bandCount, `${period}-01`);
    const payload: Record<string, Json> = {
      rule,
      count: rule === "band_below" ? bandCount : keys.length,
    };
    if (period !== "-") payload.month = period;
    try {
      const result = await notify(admin, {
        orgId: org.id,
        userIds: await recipients(admin, org.id, rule),
        event: MGMT_ALERT_EVENTS[rule],
        type: MGMT_ALERT_EVENTS[rule],
        title: msg.title,
        body: msg.body,
        payload,
      });
      totals.notified += result?.recipients ?? 0;
    } catch {
      // Not announced: release the claims so tomorrow's run reopens them (the claim reopens a cleared key).
      totals.failed++;
      for (const k of keys) {
        await admin
          .from("fin_mgmt_alert_state")
          .update({ cleared_at: at })
          .eq("org_id", org.id)
          .eq("rule", k.rule)
          .eq("scope", k.scope)
          .eq("period", k.period)
          .is("cleared_at", null);
      }
    }
  }
  return totals;
}
