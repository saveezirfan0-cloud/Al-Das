import "server-only";

import {
  buildFlashSummary,
  buildSalesGrid,
  compareGrids,
  lineFromRow,
  monthOf,
  parseFlashRows,
  previousMonthPeriod,
  targetFromRow,
  type FlashSummary,
  type GridComparison,
  type ReportLine,
  type RevenueTarget,
  type SalesGrid,
  type ShareBasis,
} from "@/lib/finance/flash";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads everything the flash report needs for one day: the configured lines, the month's targets, the two display
 * settings and the aggregated invoice rows from the first of the month to that day. Service role only, so every caller
 * must have checked finance.flash.view (or finance.targets.manage) first.
 */

export type FlashReport = {
  day: string;
  month: string;
  daily: FlashSummary;
  monthToDate: FlashSummary;
  grid: SalesGrid;
  /** The same days of the previous month, for the side-by-side grid. */
  previousGrid: SalesGrid | null;
  comparison: GridComparison | null;
  configuredLines: number;
  lastReceivedAt: string | null;
  shareBasis: ShareBasis;
  topDoctors: number;
};

export async function loadLines(admin: AdminClient, orgId: string): Promise<ReportLine[]> {
  const { data, error } = await admin
    .from("fin_ref_report_lines")
    .select("code, label, match_kind, match_values, in_core, sort_order")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("sort_order");
  if (error) throw new Error("Could not load the reporting lines.");
  return (data ?? []).map(lineFromRow);
}

export async function loadTargets(
  admin: AdminClient,
  orgId: string,
  month: string,
): Promise<RevenueTarget[]> {
  const { data, error } = await admin
    .from("fin_ref_revenue_targets")
    .select("month, line_code, daily_revenue, daily_patients, arpp, operating_days")
    .eq("org_id", orgId)
    .eq("month", month);
  if (error) throw new Error("Could not load the targets.");
  return (data ?? []).map(targetFromRow);
}

export async function loadFlashReport(
  admin: AdminClient,
  orgId: string,
  day: string,
): Promise<FlashReport> {
  const month = monthOf(day);
  if (!month) throw new Error("Choose a day.");
  const prev = previousMonthPeriod(day);
  const [lines, targets, settings, inputs, prevInputs] = await Promise.all([
    loadLines(admin, orgId),
    loadTargets(admin, orgId, month),
    admin
      .from("fin_ref_finance_settings")
      .select("flash_share_basis, flash_top_doctors")
      .eq("org_id", orgId)
      .maybeSingle(),
    admin.rpc("fin_flash_inputs", { p_org_id: orgId, p_from: month, p_to: day }),
    prev
      ? admin.rpc("fin_flash_inputs", { p_org_id: orgId, p_from: prev.month, p_to: prev.asOf })
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (inputs.error) throw new Error("Could not load the invoices for the flash report.");
  const rows = parseFlashRows(inputs.data);
  const grid = buildSalesGrid({ rows, lines, month, asOf: day });
  const previousGrid =
    prev && !prevInputs.error
      ? buildSalesGrid({ rows: parseFlashRows(prevInputs.data), lines, month: prev.month, asOf: prev.asOf })
      : null;
  const shareBasis: ShareBasis = settings.data?.flash_share_basis === "all" ? "all" : "section";
  const topDoctors = settings.data?.flash_top_doctors ?? 5;
  const lastReceivedAt =
    ((inputs.data as { last_received_at?: string | null } | null)?.last_received_at ?? null) ||
    null;
  return {
    day,
    month,
    daily: buildFlashSummary({ rows, lines, targets, from: day, to: day, shareBasis }),
    monthToDate: buildFlashSummary({ rows, lines, targets, from: month, to: day, shareBasis }),
    grid,
    previousGrid,
    comparison: previousGrid ? compareGrids(grid, previousGrid) : null,
    configuredLines: lines.length,
    lastReceivedAt,
    shareBasis,
    topDoctors,
  };
}
