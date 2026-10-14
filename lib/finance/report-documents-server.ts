import "server-only";

import { XLSX_TYPE } from "@/lib/export/table-xlsx";
import { flashPdf } from "@/lib/finance/flash-pdf";
import { loadFlashReport } from "@/lib/finance/flash-server";
import { flashWorkbook } from "@/lib/finance/flash-xlsx";
import { lockLabel } from "@/lib/finance/report-emails";
import type { SummaryRow } from "@/lib/finance/summary";
import {
  buildSummaryReport,
  previousMonths,
  summaryPdf,
  summaryWorkbook,
  type SummaryReport,
} from "@/lib/finance/summary-report";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The finance reports as files (Phase G): the daily flash and the monthly summary as Excel or PDF, for the download
 * routes, the Reports hub's e-mail and the scheduled e-mails. Service role; every caller has checked the report's own
 * key first (the routes and the hub action with can(), the job with the recipient's permission at send time).
 */

export type ReportFormat = "xlsx" | "pdf";
export type RenderedReport = {
  body: Buffer;
  contentType: string;
  provisional: boolean;
  /** Rows in the main table (for the export log). */
  rows: number;
};

const CONTENT_TYPE: Record<ReportFormat, string> = { xlsx: XLSX_TYPE, pdf: "application/pdf" };

export async function renderFlashDocument(
  admin: AdminClient,
  org: { id: string; name: string },
  day: string,
  format: ReportFormat,
): Promise<RenderedReport> {
  const [report, locked] = await Promise.all([
    loadFlashReport(admin, org.id, day),
    monthLocked(admin, org.id, day),
  ]);
  const status = lockLabel(new Set(locked ? [report.month] : []), [report.month]);
  const builtAt = new Date().toISOString();
  const body =
    format === "pdf"
      ? await flashPdf({
          org: org.name,
          day,
          month: report.grid.month,
          daily: report.daily,
          monthToDate: report.monthToDate,
          topDoctors: report.topDoctors,
          status,
          builtAt,
        })
      : await flashWorkbook({
          org: org.name,
          day,
          daily: report.daily,
          monthToDate: report.monthToDate,
          grid: report.grid,
          previousGrid: report.previousGrid,
          comparison: report.comparison,
          topDoctors: report.topDoctors,
          builtAt,
          status,
        });
  return {
    body,
    contentType: CONTENT_TYPE[format],
    provisional: !locked,
    rows: report.grid.days.length,
  };
}

export async function renderSummaryDocument(
  admin: AdminClient,
  org: { id: string; name: string },
  range: { from: string; to: string; branch: string | null },
  format: ReportFormat,
): Promise<RenderedReport> {
  const report = await loadSummaryReport(admin, org.id, range);
  const meta = { org: org.name, builtAt: new Date().toISOString() };
  return {
    body: format === "pdf" ? await summaryPdf(report, meta) : await summaryWorkbook(report, meta),
    contentType: CONTENT_TYPE[format],
    provisional: report.provisional,
    rows: report.rows.length,
  };
}

/**
 * Reads the monthly summary for a range of months (and the equal range before it) and which months are locked, with the
 * service role. Callers have run can(member, 'finance.view') (the route, the hub action) or the job's recipient check.
 */
export async function loadSummaryReport(
  admin: AdminClient,
  orgId: string,
  input: { from: string; to: string; branch: string | null },
): Promise<SummaryReport> {
  const prev = previousMonths(input.from, input.to);
  const [measures, closes] = await Promise.all([
    fetchAll((a, b) => {
      let q = admin
        .from("v_fin_monthly_measures")
        .select(
          "month, branch_code, generated, claimed, accepted, paid_allocated, remitted, rejected, outstanding, self_pay_collected",
        )
        .eq("org_id", orgId)
        .gte("month", `${prev.from}-01`)
        .lte("month", `${input.to}-01`);
      if (input.branch) q = q.eq("branch_code", input.branch);
      return q.order("month").order("branch_code").range(a, b);
    }),
    admin
      .from("fin_period_closes")
      .select("month, locked_at")
      .eq("org_id", orgId)
      .gte("month", `${input.from}-01`)
      .lte("month", `${input.to}-01`),
  ]);
  if (measures.error || closes.error) throw new Error("summary read failed");
  return buildSummaryReport({
    ...input,
    rows: measures.data
      .filter((r) => !!r.month)
      .map((r): SummaryRow => ({ ...r, month: String(r.month) })),
    lockedMonths: new Set(
      (closes.data ?? []).filter((c) => c.locked_at).map((c) => String(c.month).slice(0, 7)),
    ),
  });
}

/** Is the month of this day locked by the CEO sign-off? (The flash is Provisional until it is.) */
export async function monthLocked(admin: AdminClient, orgId: string, day: string): Promise<boolean> {
  const { data } = await admin
    .from("fin_period_closes")
    .select("locked_at")
    .eq("org_id", orgId)
    .eq("month", `${day.slice(0, 7)}-01`)
    .maybeSingle();
  return !!data?.locked_at;
}
