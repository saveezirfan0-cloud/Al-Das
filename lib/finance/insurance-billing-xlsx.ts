import { monthTitle } from "@/lib/finance/flash-xlsx";
import {
  UNREPORTED_NOTE,
  type BilledInvoice,
  type InsuranceBillingRecon,
} from "@/lib/finance/insurance-billing";

/**
 * Insurance billed vs claimed as an .xlsx workbook: Summary, Billed not submitted, Matched, Not in report, Ambiguous
 * and Definitions. Every cell is a plain value (no formulas). Invoice numbers, dates, amounts, payer ids, branch codes
 * and doctor names only: no PIN, no patient ref, no patient names, no card numbers.
 */

export type InsuranceBillingWorkbookInput = {
  org: string;
  report: InsuranceBillingRecon;
  branchLabel: string;
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";
const PCT = "0.0%";

export const INSURANCE_BILLING_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Billed",
    "Unite collection report (current rows of committed uploads): the Insurance Claim amount of each row in the month (report date = invoice date, else visit date), by insurance invoice number. Cancelled rows are left out and counted on their own.",
  ],
  [
    "Submitted",
    "Diligence: the net (initial net when net is blank) of every claim activity with the same invoice number, as of the latest Diligence upload.",
  ],
  [
    "Invoice number",
    "Compared in upper case with all spaces removed, the same rule as the Unite invoice key.",
  ],
  [
    "Matched",
    "Diligence has the invoice number. Difference = billed − submitted; flagged when it is more than the tolerance either way.",
  ],
  [
    "Billed, not submitted",
    "Billed more than 0, no Diligence activity, and more than the grace days since the report date. The money at risk.",
  ],
  ["Awaiting", "Billed, not submitted yet, still inside the grace days. Not counted as at risk."],
  [
    "Not in report",
    "Diligence activities dated in the month (service date, else transaction date) whose invoice number is on no row of this month's report. Check the month: they may belong to another month, or the invoice was cancelled. Shown only to members who see every branch, with no branch filter.",
  ],
  [
    "Ambiguous",
    "The month's report gives the invoice number more than one branch or doctor. Never paired automatically.",
  ],
  [
    "Matched %",
    "Billed AED on invoice numbers Diligence has (matched, any difference) ÷ all billed AED.",
  ],
];

const pairs = (inv: BilledInvoice) =>
  inv.visiblePairs.map((p) => `${p.branch ?? "Unknown"}: ${p.doctor}`).join("; ");

export async function insuranceBillingWorkbook(
  input: InsuranceBillingWorkbookInput,
): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const r = input.report;
  const s = r.summary;
  const month = monthTitle(r.month);

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const header = (ws: Sheet, cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
    });
  };
  const sheet = (name: string, what: string, widths: number[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = widths.map((width) => ({ width }));
    ws.addRow([`${input.org}: ${what}, ${month}`]).font = { bold: true, size: 13 };
    ws.addRow([
      `Branch: ${input.branchLabel}. As of ${r.asOf}. Covered dates: ${r.coverage.label}.`,
    ]);
    ws.addRow([]);
    return ws;
  };
  const money = (ws: Sheet, rowNo: number, cols: number[]) => {
    for (const c of cols) ws.getRow(rowNo).getCell(c).numFmt = MONEY;
  };

  const sum = sheet("Summary", "insurance billed vs claimed", [44, 16, 16]);
  header(sum, ["Measure", "AED", "Count"]);
  const summaryRows: [string, number | string, number | string][] = [
    ["Billed (Unite report)", s.billed, s.billedRows],
    [
      "Submitted on this month's invoice numbers (Diligence)",
      s.submitted,
      s.matchedCount + s.ambiguousCount,
    ],
    ["Matched % (of billed AED)", s.matchedPct ?? "", s.matchedCount],
    ["Differences over the tolerance", s.flaggedDifference, s.flaggedCount],
    ["At risk: billed, not submitted past the grace days", s.atRisk, s.atRiskCount],
    ["Awaiting: inside the grace days", s.awaitingAmount, s.awaitingCount],
    ["Ambiguous invoice numbers", "", s.ambiguousCount],
    ["Billed rows without an insurance invoice number", s.noInvoiceNoAmount, s.noInvoiceNoRows],
    ["Cancelled rows with an insurance claim (left out)", s.cancelledAmount, s.cancelledRows],
  ];
  if (r.unreportedShown)
    summaryRows.push(
      ["Submitted, not in this month's report", s.unreportedAmount, s.unreportedCount],
      [
        "Submitted without an invoice number",
        s.submittedNoInvoiceNoAmount,
        s.submittedNoInvoiceNoActivities,
      ],
    );
  for (const row of summaryRows) {
    const added = sum.addRow(row);
    added.getCell(2).numFmt = row[0].startsWith("Matched %") ? PCT : MONEY;
  }
  sum.addRow([]);
  sum.addRow(["Tolerance (AED)", r.settings.tolerance]);
  sum.addRow(["Grace days", r.settings.graceDays]);
  if (!r.coverage.full)
    sum.addRow([`Warning: ${month} is only partly covered (${r.coverage.label}).`]);
  if (!r.unreportedShown)
    sum.addRow([
      "Submitted, not in the report: shown only for every branch with no branch filter (Diligence has no branch).",
    ]);

  const late = sheet("Billed not submitted", "billed, not submitted", [20, 12, 10, 16, 40]);
  header(late, ["Invoice number", "Report date", "Days", "Billed", "Branch: doctor"]);
  for (const x of [...r.billedNotSubmitted, ...r.awaiting]) {
    const row = late.addRow([x.invoiceNo, x.lastDate, x.ageDays, x.billed, pairs(x)]);
    money(late, row.number, [4]);
  }
  if (r.awaiting.length > 0)
    late.addRow([
      `The last ${r.awaiting.length} are inside the grace days (awaiting, not at risk).`,
    ]);

  const matched = sheet("Matched", "matched invoice numbers", [20, 12, 16, 16, 16, 10, 12, 18, 40]);
  header(matched, [
    "Invoice number",
    "Report date",
    "Billed",
    "Submitted",
    "Difference",
    "Flagged",
    "Activities",
    "Payers",
    "Branch: doctor",
  ]);
  for (const x of r.matched) {
    const row = matched.addRow([
      x.invoiceNo,
      x.lastDate,
      x.billed,
      x.submitted,
      x.difference,
      x.flagged ? "Yes" : "",
      x.activities,
      x.payers.join(", "),
      pairs(x),
    ]);
    money(matched, row.number, [3, 4, 5]);
  }

  const un = sheet(
    "Not in report",
    "submitted, not in this month's report",
    [20, 12, 16, 12, 18, 14, 44],
  );
  header(un, [
    "Invoice number",
    "Activity date",
    "Submitted",
    "Activities",
    "Payers",
    "Report month",
    "Note",
  ]);
  if (!r.unreportedShown)
    un.addRow([
      "Shown only for every branch with no branch filter: Diligence activities have no branch.",
    ]);
  for (const x of r.unreported) {
    const row = un.addRow([
      x.invoiceNo,
      x.firstDate ?? "",
      x.submitted,
      x.activities,
      x.payers.join(", "),
      x.reportMonth ? x.reportMonth.slice(0, 7) : "",
      UNREPORTED_NOTE[x.note],
    ]);
    money(un, row.number, [3]);
  }

  const amb = sheet("Ambiguous", "ambiguous invoice numbers", [20, 12, 16, 16, 14, 60]);
  header(amb, [
    "Invoice number",
    "Report date",
    "Billed",
    "Submitted",
    "Branch/doctor pairs",
    "Branch: doctor (yours)",
  ]);
  for (const x of r.ambiguous) {
    const row = amb.addRow([
      x.invoiceNo,
      x.lastDate,
      x.billed,
      x.submitted ?? "",
      x.pairs,
      pairs(x),
    ]);
    money(amb, row.number, [3, 4]);
  }

  const defs = wb.addWorksheet("Definitions");
  defs.columns = [{ width: 24 }, { width: 120 }];
  defs.addRow(["Definitions"]).font = { bold: true, size: 13 };
  header(defs, ["Term", "Definition"]);
  for (const [k, v] of INSURANCE_BILLING_DEFINITIONS) defs.addRow([k, v]);
  defs.addRow([]);
  defs.addRow(["Built", input.builtAt]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
