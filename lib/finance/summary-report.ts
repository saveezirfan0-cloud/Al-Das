import { tablesWorkbook, type TableColumn } from "@/lib/export/table-xlsx";
import { lockLabel, shiftMonth } from "@/lib/finance/report-emails";
import { SUMMARY_COLUMNS, totals, type SummaryColumn, type SummaryRow } from "@/lib/finance/summary";

/**
 * The monthly summary as a document (Phase G): the same numbers as Finance, Monthly summary (v_fin_monthly_measures),
 * for a range of months and optionally one branch, with the equal range before it for comparison. Used by the Excel and
 * PDF downloads, the Reports hub's e-mail and the scheduled monthly e-mail. Aggregates by month and branch code only:
 * no patient, doctor or payer. Labelled Provisional until every month is locked by the CEO sign-off.
 */

export const SUMMARY_HEAD: Record<SummaryColumn, string> = {
  generated: "Generated",
  claimed: "Claimed",
  accepted: "Accepted",
  paid_allocated: "Paid (allocated)",
  remitted: "Remitted",
  rejected: "Rejected",
  outstanding: "Outstanding",
  self_pay_collected: "Self-pay collected",
};

export type SummaryReport = {
  from: string;
  to: string;
  branch: string | null;
  previous: { from: string; to: string };
  rows: SummaryRow[];
  totals: Record<SummaryColumn, number>;
  previousTotals: Record<SummaryColumn, number>;
  /** "Final: ..." or "Provisional: ..." */
  status: string;
  provisional: boolean;
};

/** Months from..to inclusive (yyyy-mm), at most 36. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 36; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/** The equal-length range directly before from..to. */
export function previousMonths(from: string, to: string): { from: string; to: string } {
  const n = Math.max(1, monthsBetween(from, to).length);
  return { from: shiftMonth(from, -n), to: shiftMonth(from, -1) };
}

/** Builds the report from the view's rows (current and previous range together) and the locked months. Pure. */
export function buildSummaryReport(input: {
  from: string;
  to: string;
  branch: string | null;
  rows: readonly SummaryRow[];
  lockedMonths: ReadonlySet<string>;
}): SummaryReport {
  const previous = previousMonths(input.from, input.to);
  const inRange = (r: SummaryRow, a: string, b: string) =>
    r.month.slice(0, 7) >= a && r.month.slice(0, 7) <= b;
  const current = input.rows
    .filter((r) => inRange(r, input.from, input.to))
    .sort(
      (a, b) =>
        b.month.localeCompare(a.month) || (a.branch_code ?? "").localeCompare(b.branch_code ?? ""),
    );
  const before = input.rows.filter((r) => inRange(r, previous.from, previous.to));
  const months = monthsBetween(input.from, input.to);
  const status = lockLabel(input.lockedMonths, months);
  return {
    from: input.from,
    to: input.to,
    branch: input.branch,
    previous,
    rows: current,
    totals: totals(current),
    previousTotals: totals(before),
    status,
    provisional: !status.startsWith("Final"),
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Change against the period before, as a fraction (null when the period before was zero). */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 1000;
}

function rangeText(r: SummaryReport): string {
  return r.from === r.to ? r.from : `${r.from} to ${r.to}`;
}

export async function summaryWorkbook(
  r: SummaryReport,
  meta: { org: string; builtAt: string },
): Promise<Buffer> {
  const money: TableColumn[] = SUMMARY_COLUMNS.map((c) => ({
    header: `${SUMMARY_HEAD[c]} (AED)`,
    kind: "money",
  }));
  const lines = [
    `Months: ${rangeText(r)}${r.branch ? `, branch ${r.branch}` : ", all branches"}`,
    r.status,
  ];
  return tablesWorkbook({
    org: meta.org,
    builtAt: meta.builtAt,
    sheets: [
      {
        sheet: "Summary",
        title: "Monthly finance summary",
        lines,
        columns: [{ header: "Month", width: 10 }, { header: "Branch", width: 10 }, ...money],
        rows: r.rows.map((row) => [
          row.month.slice(0, 7),
          row.branch_code ?? "unknown",
          ...SUMMARY_COLUMNS.map((c) => row[c] ?? null),
        ]),
        totals: ["Total", "", ...SUMMARY_COLUMNS.map((c) => r.totals[c])],
      },
      {
        sheet: "Compared",
        title: `Compared with ${r.previous.from === r.previous.to ? r.previous.from : `${r.previous.from} to ${r.previous.to}`}`,
        lines,
        columns: [
          { header: "Measure", width: 22 },
          { header: "This period (AED)", kind: "money" },
          { header: "Period before (AED)", kind: "money" },
          { header: "Change (AED)", kind: "money" },
          { header: "Change %", kind: "number" },
        ],
        rows: SUMMARY_COLUMNS.map((c) => {
          const pct = change(r.totals[c], r.previousTotals[c]);
          return [
            SUMMARY_HEAD[c],
            r.totals[c],
            r.previousTotals[c],
            r2(r.totals[c] - r.previousTotals[c]),
            pct === null ? null : Math.round(pct * 1000) / 10,
          ];
        }),
      },
    ],
  });
}

const whole = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "-"
    : Math.round(Number(n)).toLocaleString("en-GB");

export async function summaryPdf(
  r: SummaryReport,
  meta: { org: string; builtAt: string },
): Promise<Buffer> {
  const { makeDoc, MARGIN, PAGE_W } = await import("@/lib/accounting/sales-pdf");
  const p = await makeDoc(`Monthly finance summary ${rangeText(r)}`, new Date(meta.builtAt));
  p.text(meta.org || "Pulse", MARGIN, 12, p.bold);
  p.right("Monthly finance summary", PAGE_W - MARGIN, 14, p.bold);
  p.y -= 18;
  p.para(`Months: ${rangeText(r)}${r.branch ? `, branch ${r.branch}` : ", all branches"}`, 9);
  p.para(r.status, 9, p.bold);
  p.para("Amounts in AED, rounded to the dirham. Aggregates only.", 8, p.font, p.grey);

  p.heading("Totals compared with the period before");
  p.table(
    [
      { label: "Measure", width: 155 },
      { label: "This period", width: 90, align: "right" },
      { label: "Period before", width: 90, align: "right" },
      { label: "Change", width: 90, align: "right" },
      { label: "Change %", width: 90.28, align: "right" },
    ],
    SUMMARY_COLUMNS.map((c) => {
      const pct = change(r.totals[c], r.previousTotals[c]);
      return [
        SUMMARY_HEAD[c],
        whole(r.totals[c]),
        whole(r.previousTotals[c]),
        whole(r.totals[c] - r.previousTotals[c]),
        pct === null ? "-" : `${(pct * 100).toFixed(1)}%`,
      ];
    }),
  );

  p.heading("By month and branch");
  const colW = (515.28 - 50 - 41) / SUMMARY_COLUMNS.length;
  p.table(
    [
      { label: "Month", width: 50 },
      { label: "Branch", width: 41 },
      ...SUMMARY_COLUMNS.map((c) => ({
        label: SUMMARY_HEAD[c],
        width: colW,
        align: "right" as const,
      })),
    ],
    r.rows.length
      ? [
          ...r.rows.map((row) => [
            row.month.slice(0, 7),
            row.branch_code ?? "unknown",
            ...SUMMARY_COLUMNS.map((c) => whole(row[c])),
          ]),
          ["Total", "", ...SUMMARY_COLUMNS.map((c) => whole(r.totals[c]))],
        ]
      : [["", "No data for these months", ...SUMMARY_COLUMNS.map(() => "")]],
    r.rows.length > 0,
  );
  p.y -= 6;
  p.para(`Built ${meta.builtAt.slice(0, 16).replace("T", " ")} UTC.`, 8, p.font, p.grey);
  p.footer(`Monthly finance summary ${rangeText(r)} - ${r.provisional ? "Provisional" : "Final"}`);
  return Buffer.from(await p.doc.save());
}
