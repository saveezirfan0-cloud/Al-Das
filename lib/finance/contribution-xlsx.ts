import {
  MIN_PAID_DOCTORS,
  PAY_STATUS_LABEL,
  PROVISIONAL_LABEL,
  type ClinicLevels,
  type ContributionReport,
  type Level,
} from "@/lib/finance/contribution";
import { monthTitle } from "@/lib/finance/flash-xlsx";

/**
 * The contribution report as an .xlsx workbook: "Contribution" and "Definitions". Plain values only (no formulas).
 * Built from the same pure result as the page, so without finance.costs.compensation the pay column is not in the file
 * at all and withheld totals say "Withheld". Amounts, doctor names and DHA ids only: no patient data.
 */

export type ContributionWorkbookInput = {
  org: string;
  report: ContributionReport;
  branchLabel: string;
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";
const PCT = "0.0%";
const WITHHELD = "Withheld";

export const CONTRIBUTION_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Revenue",
    "Unite Net Billing (after discount, before VAT) from the current Unite collection report rows of the month, AED.",
  ],
  [
    "Doctor pay",
    "The compensation Finance loaded for the doctor and month (Finance, Costs). Never calculated by Pulse. A doctor's pay is split over all their rows in the month (branches, departments) by revenue.",
  ],
  [
    "Charges",
    "Lab, referral, consumables and other charges recorded for the doctor and month, split the same way.",
  ],
  ["Contribution (L3)", "Revenue − doctor pay − charges, per doctor."],
  [
    "Department",
    "The sum of its doctors. Department cost pools (L4) are not loaded yet; expected revenue after denials (L2) is not available yet.",
  ],
  ["Clinic contribution (L5)", "The doctors' contribution − the branch's own overheads."],
  [
    "After allocation (L6)",
    "L5 − the shared overhead pools, allocated to each branch by their basis (revenue, visits or equal); shown as its own line.",
  ],
  [
    "Pay coverage",
    "The share of revenue whose doctor is linked to a DHA id AND has pay loaded for the month. Pay, charges and contribution add up only those doctors; the rest is never counted as zero pay.",
  ],
  [
    "Pay not linked / not loaded",
    "Not linked: the report doctor has no DHA id link yet. Not loaded: linked, but no pay (or a 0, which means unavailable) for the month.",
  ],
  [
    PROVISIONAL_LABEL,
    "Until Finance approves the month's costs AND every doctor with revenue has pay loaded (and the report covers the whole month).",
  ],
  [
    WITHHELD,
    `Without the doctor compensation permission, individual pay is not shown, every department and clinic figure that includes pay is withheld (two such figures sharing doctors would let individual pay be worked out), and only the whole organisation's unfiltered total is shown, when pay from at least ${MIN_PAID_DOCTORS} doctors is in it.`,
  ],
];

export async function contributionWorkbook(input: ContributionWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const r = input.report;
  const pay = r.canSeePay;

  const ws = wb.addWorksheet("Contribution");
  ws.addRow([`${input.org}: contribution, ${monthTitle(r.month)}`]).font = { bold: true, size: 13 };
  ws.addRow([`Branch: ${input.branchLabel}. Covered dates: ${r.dates.label}.`]);
  ws.addRow([
    r.provisional
      ? `${PROVISIONAL_LABEL}: ${r.reasons.join(" ")}`
      : "Final: Finance approved the month and every doctor has pay loaded.",
  ]);
  ws.addRow([]);
  const head = ws.addRow([
    "Level",
    "Clinic",
    "Department",
    "Doctor",
    "DHA id",
    "Revenue",
    "Pay coverage / status",
    ...(pay ? ["Doctor pay"] : []),
    "Charges",
    "Contribution",
  ]);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
  });

  const blank = (v: number | null) => (v === null ? "" : v);
  const contrib = (v: number | null, withheld: boolean) => (withheld ? WITHHELD : blank(v));
  const levelRow = (kind: string, clinic: string, dept: string, l: Level) =>
    ws.addRow([
      kind,
      clinic,
      dept,
      "",
      "",
      l.revenue,
      blank(l.coverage),
      ...(pay ? [blank(l.pay)] : []),
      l.charges,
      contrib(l.contribution, l.withheld),
    ]);
  const lines = (clinic: string, l: Level & ClinicLevels) => {
    const add = (kind: string, v: number | string) =>
      ws.addRow([kind, clinic, "", "", "", "", "", ...(pay ? [""] : []), "", v]);
    add("Less branch overheads", -l.branchOverhead);
    add("Clinic contribution (L5)", contrib(l.l5, l.withheld)).font = { bold: true };
    add("Less shared overhead allocated", -l.allocated);
    add("After allocation (L6)", contrib(l.l6, l.withheld)).font = { bold: true };
  };

  for (const c of r.clinics) {
    levelRow("Clinic", c.label, "", c).font = { bold: true };
    for (const d of c.departments) {
      levelRow("Department", c.label, d.label, d);
      for (const doc of d.doctors)
        ws.addRow([
          "Doctor",
          c.label,
          d.label,
          doc.name,
          doc.dhaId ?? "",
          doc.revenue,
          PAY_STATUS_LABEL[doc.status],
          ...(pay ? [blank(doc.pay)] : []),
          blank(doc.charges),
          blank(doc.contribution),
        ]);
    }
    lines(c.label, c);
  }
  levelRow("Total", "All clinics shown", "", r.total).font = { bold: true };
  lines("All clinics shown", r.total);

  const moneyCols = pay ? [6, 8, 9, 10] : [6, 8, 9];
  for (const i of moneyCols) ws.getColumn(i).numFmt = MONEY;
  ws.getColumn(7).numFmt = PCT;
  ws.getColumn(1).width = 30;
  for (const i of [2, 3, 4]) ws.getColumn(i).width = 24;
  for (let i = 5; i <= (pay ? 10 : 9); i++)
    if (ws.getColumn(i).width === undefined) ws.getColumn(i).width = 16;

  const defs = wb.addWorksheet("Definitions");
  defs.addRow(["Term", "Meaning"]).font = { bold: true };
  for (const [k, v] of CONTRIBUTION_DEFINITIONS) defs.addRow([k, v]);
  defs.getColumn(1).width = 28;
  defs.getColumn(2).width = 110;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
