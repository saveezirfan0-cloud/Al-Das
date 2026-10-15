import {
  SUM_COLUMNS,
  UNKNOWN_BRANCH_LABEL,
  type Collections,
  type Sums,
} from "@/lib/finance/collections";
import { monthTitle } from "@/lib/finance/flash-xlsx";

/**
 * Collections and data quality as an .xlsx workbook: "Daily", "Branches", "Doctors", "Data quality" and
 * "Definitions". Every cell is a plain value (no formulas), so the totals are Pulse's own and nothing typed into Unite
 * can run in a spreadsheet. Counts, amounts, doctor names and unmapped Unite clinic names only: no patient data.
 */

export type CollectionsWorkbookInput = {
  org: string;
  report: Collections;
  branchLabel: string;
  /** Finance branch code -> name (codes without a name show as the code). */
  branchNames: Record<string, string>;
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";

export const COLLECTIONS_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Source",
    "Unite Daily Collection report uploads (current rows only) for the month, by report date (invoice date, else visit date).",
  ],
  [
    "Rows",
    "Number of report rows (one per visit or invoice line in Unite's report). Cancelled rows count, as in Unite's totals.",
  ],
  [
    "Cash, Card, Bank transfer, Payment gateway, Other payment",
    "Unite's payment columns for the invoice, AED.",
  ],
  ["Total collected", "Cash + Card + Bank transfer + Payment gateway + Other payment."],
  ["Patient share, Insurance claim", "Unite's patient share and insurance claim columns."],
  ["Net billing", "Unite Net Billing (after discount, before VAT)."],
  [
    "Advance consumed, Credit note consumed, Outstanding credit, Write-off, Refund",
    "Unite's columns of the same names.",
  ],
  [
    "Invoice type",
    "Self-pay (SELF PAID), Insurance (INSURANCE), both, blank, or not recognised. Any other word is listed as not recognised, never guessed.",
  ],
  [
    "Reconciliation",
    "Net billing against Total collected + Insurance claim + Patient share + Outstanding credit + Advance consumed + Credit note consumed. The difference is shown, not assumed to be 0: Unite's columns are not guaranteed to add up.",
  ],
  [
    "Branch",
    "From the Unite clinic name and the current branch mapping (Finance, Reference data).",
  ],
  ["Doctor", "Grouped by the normalised Unite doctor name; shown with its most frequent spelling."],
  [
    "Data quality",
    "Review signals, never proof. A row can appear in more than one signal. AED is the rows' net billing.",
  ],
];

export async function collectionsWorkbook(input: CollectionsWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const r = input.report;
  const month = monthTitle(r.month);

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const header = (ws: Sheet, cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
    });
  };
  const heading = (ws: Sheet, what: string) => {
    ws.addRow([`${input.org}: ${what}, ${month}`]).font = { bold: true, size: 13 };
    ws.addRow([`Branch: ${input.branchLabel}. Covered dates: ${r.coverageInfo.label}.`]);
    ws.addRow([]);
  };
  const sumHeads = ["Rows", ...SUM_COLUMNS.map(([, label]) => label)];
  const sumValues = (s: Sums) => [s.rows, ...SUM_COLUMNS.map(([k]) => s[k])];
  /** Adds a row of label cells then the sums, formatting the money cells. */
  const sumRow = (ws: Sheet, labels: (string | number)[], s: Sums, bold = false) => {
    const row = ws.addRow([...labels, ...sumValues(s)]);
    for (let i = 0; i < SUM_COLUMNS.length; i++) row.getCell(labels.length + 2 + i).numFmt = MONEY;
    if (bold) row.font = { bold: true };
    return row;
  };
  const widths = (ws: Sheet, first: number[]) => {
    ws.columns = [
      ...first.map((width) => ({ width })),
      { width: 8 },
      ...SUM_COLUMNS.map(() => ({ width: 15 })),
    ];
  };
  const branchName = (code: string | null) =>
    code === null ? UNKNOWN_BRANCH_LABEL : (input.branchNames[code] ?? code);

  // Daily
  const daily = wb.addWorksheet("Daily");
  widths(daily, [12]);
  heading(daily, "collections by day");
  header(daily, ["Date", ...sumHeads]);
  for (const d of r.days) sumRow(daily, [d.date], d);
  sumRow(daily, ["Total"], r.total, true);
  daily.addRow([]);
  daily.addRow([
    `Reconciliation: net billing ${r.reconciliation.net.toFixed(2)} against collected, claims, shares, credit and consumption ${r.reconciliation.accountedFor.toFixed(2)}; difference ${r.reconciliation.difference.toFixed(2)} (shown, not assumed to be 0).`,
  ]);

  // Branches, then the self-pay and insurance split
  const branches = wb.addWorksheet("Branches");
  widths(branches, [34, 30]);
  heading(branches, "collections by branch");
  header(branches, ["Branch", "Code", ...sumHeads]);
  for (const b of r.branches) sumRow(branches, [branchName(b.branchCode), b.branchCode ?? ""], b);
  sumRow(branches, ["Total", ""], r.total, true);
  branches.addRow([]);
  header(branches, ["Invoice type", "Unite values", ...sumHeads]);
  for (const b of r.buckets) sumRow(branches, [b.label, b.types.join("; ")], b);

  // Doctors
  const doctors = wb.addWorksheet("Doctors");
  doctors.columns = [{ width: 30 }, { width: 8 }, ...[1, 2, 3, 4].map(() => ({ width: 16 }))];
  heading(doctors, "collections by doctor");
  header(doctors, [
    "Doctor",
    "Rows",
    "Net billing",
    "Total collected",
    "Insurance claim",
    "Outstanding credit",
  ]);
  for (const d of r.doctors) {
    const row = doctors.addRow([
      d.name,
      d.rows,
      d.net,
      d.collected,
      d.insuranceClaim,
      d.outstandingCredit,
    ]);
    for (const c of [3, 4, 5, 6]) row.getCell(c).numFmt = MONEY;
  }

  // Data quality
  const dq = wb.addWorksheet("Data quality");
  dq.columns = [{ width: 36 }, { width: 8 }, { width: 16 }, { width: 70 }, { width: 90 }];
  heading(dq, "data quality signals");
  header(dq, ["Signal", "Rows", "Net (AED)", "What it means", "What to do"]);
  for (const s of r.signals) {
    const row = dq.addRow([s.title, s.rows, s.net, s.sentence, s.action]);
    row.getCell(3).numFmt = MONEY;
  }
  if (r.unknownClinics.length > 0) {
    dq.addRow([]);
    header(dq, ["Unite clinic not mapped", "Rows", "Net (AED)"]);
    for (const c of r.unknownClinics) {
      const row = dq.addRow([c.clinic ?? "(blank clinic)", c.rows, c.net]);
      row.getCell(3).numFmt = MONEY;
    }
  }
  dq.addRow([]);
  dq.addRow(["Review signals, never proof. A row can appear in more than one signal."]);

  // Definitions
  const defs = wb.addWorksheet("Definitions");
  defs.columns = [{ width: 34 }, { width: 110 }];
  defs.addRow(["Definitions"]).font = { bold: true, size: 13 };
  header(defs, ["Measure", "Definition"]);
  for (const [k, v] of COLLECTIONS_DEFINITIONS) defs.addRow([k, v]);
  defs.addRow([]);
  header(defs, ["Setting", "Value"]);
  defs.addRow(["Late invoice: more than this many days after the visit", r.lateInvoiceDays]);
  defs.addRow([]);
  defs.addRow(["Built", input.builtAt]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
