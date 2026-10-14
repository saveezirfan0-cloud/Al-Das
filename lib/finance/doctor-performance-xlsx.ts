import {
  BAND_LABEL,
  type DoctorPerformance,
  type Measures,
} from "@/lib/finance/doctor-performance";
import { monthTitle } from "@/lib/finance/flash-xlsx";

/**
 * The doctor performance report as an .xlsx workbook: "Doctors", "Departments" and "Definitions". Every cell is a
 * plain value (no formulas), so the totals are Pulse's own and nothing typed into Unite can run in a spreadsheet.
 * Counts, amounts and doctor names only: no patient data.
 */

export type DoctorPerformanceWorkbookInput = {
  org: string;
  report: DoctorPerformance;
  branchLabel: string;
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";
const PCT = "0.0%;[Red]-0.0%";
const RATIO = "0.00";

export const DOCTOR_PERFORMANCE_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Source",
    "Unite Daily Collection report uploads (current rows only), grouped by report date (invoice date, else visit date).",
  ],
  [
    "Revenue",
    "Sum of Unite Net Billing (after discount, before VAT), AED. Cancelled rows count, as in Unite's own totals.",
  ],
  ["Visits", "Number of report rows."],
  [
    "Patients",
    "Distinct patients. A department or the clinic counts each patient once, however many doctors saw them.",
  ],
  [
    "Unbilled",
    "Patients whose net for that doctor and department (or level) in the month adds up to 0 or less.",
  ],
  ["New", "Visits Unite marks as New."],
  ["Follow-ups", "Visits − patients: repeat visits within the month (never below 0)."],
  [
    "Revenue / patient",
    "Revenue ÷ patients (shown to 2 decimals; the band uses the exact figure). Blank when there are no patients.",
  ],
  [
    "Band",
    "Achieved at or above the target; Near Target, Moderate and Below Target under it (half-open, no gaps).",
  ],
  ["Expected", "Patients × target."],
  ["Gap", "Revenue − expected."],
  ["Achievement", "Revenue ÷ expected."],
  [
    "Change %",
    "(This month − previous month) ÷ previous month. Blank when the previous month had no revenue.",
  ],
  [
    "Doctor",
    "Grouped by the normalised Unite doctor name; shown with its most frequent spelling. A doctor seen in two departments appears under both.",
  ],
];

export async function doctorPerformanceWorkbook(
  input: DoctorPerformanceWorkbookInput,
): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const r = input.report;
  const month = monthTitle(r.month);
  const previous = monthTitle(r.previousMonth);

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const title = (ws: Sheet, text: string) => {
    ws.addRow([text]).font = { bold: true, size: 13 };
  };
  const header = (ws: Sheet, cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
    });
  };
  const blank = (v: number | null) => (v === null ? "" : v);
  const values = (m: Measures) => [
    m.revenue,
    m.previous.revenue,
    m.change,
    blank(m.changePct),
    m.patients,
    m.previous.patients,
    blank(m.patientsChangePct),
    m.unbilledPatients,
    blank(m.revenuePerPatient),
    m.band ? BAND_LABEL[m.band] : "",
    m.expectedRevenue,
    m.gap,
    blank(m.achievement),
    m.visits,
    m.newVisits,
    m.followUps,
    blank(m.followUpsPerPatient),
  ];
  const measureHeads = [
    `Revenue ${month}`,
    `Revenue ${previous}`,
    "Change",
    "Change %",
    "Patients",
    `Patients ${previous}`,
    "Patients change %",
    "Unbilled patients",
    "Revenue / patient",
    "Band",
    "Expected",
    "Gap",
    "Achievement",
    "Visits",
    "New",
    "Follow-ups",
    "Follow-ups / patient",
  ];
  const formatRow = (ws: Sheet, rowNo: number, offset: number) => {
    const row = ws.getRow(rowNo);
    for (const c of [1, 2, 3, 9, 11, 12]) row.getCell(offset + c).numFmt = MONEY;
    for (const c of [4, 7, 13]) row.getCell(offset + c).numFmt = PCT;
    row.getCell(offset + 17).numFmt = RATIO;
  };
  const heading = (ws: Sheet, what: string) => {
    title(ws, `${input.org}: ${what}, ${month} against ${previous}`);
    ws.addRow([`Branch: ${input.branchLabel}. Covered dates: ${r.coverage.label}.`]);
    ws.addRow([]);
  };

  const doctors = wb.addWorksheet("Doctors");
  doctors.columns = [{ width: 24 }, { width: 28 }, ...measureHeads.map(() => ({ width: 14 }))];
  heading(doctors, "doctor performance");
  header(doctors, ["Department", "Doctor", ...measureHeads]);
  for (const d of r.departments)
    for (const doc of d.doctorRows) {
      const row = doctors.addRow([d.label, doc.name, ...values(doc)]);
      formatRow(doctors, row.number, 2);
    }

  const depts = wb.addWorksheet("Departments");
  depts.columns = [
    { width: 24 },
    { width: 10 },
    { width: 12 },
    ...measureHeads.map(() => ({ width: 14 })),
  ];
  heading(depts, "department performance");
  header(depts, ["Department", "Doctors", "% of total", ...measureHeads]);
  for (const d of r.departments) {
    const row = depts.addRow([d.label, d.doctors, blank(d.share), ...values(d)]);
    row.getCell(3).numFmt = PCT;
    formatRow(depts, row.number, 3);
  }
  const total = depts.addRow([
    "Total (clinic)",
    r.total.doctors,
    r.total.revenue === 0 ? "" : 1,
    ...values(r.total),
  ]);
  total.font = { bold: true };
  total.getCell(3).numFmt = PCT;
  formatRow(depts, total.number, 3);
  depts.addRow([]);
  depts.addRow([
    `Reconciliation: departments ${r.reconciliation.departmentsSum.toFixed(2)} = total net ${r.reconciliation.total.toFixed(2)}` +
      (r.reconciliation.matches ? " (matches)." : " (DOES NOT MATCH)."),
  ]);
  if (r.total.cancelledVisits > 0)
    depts.addRow([`Includes ${r.total.cancelledVisits} cancelled visits, as Unite does.`]);
  if (!r.coverage.full)
    depts.addRow([`Warning: ${month} is only partly covered (${r.coverage.label}).`]);
  if (!r.previousCoverage.full)
    depts.addRow([`Warning: ${previous} is only partly covered (${r.previousCoverage.label}).`]);

  const defs = wb.addWorksheet("Definitions");
  defs.columns = [{ width: 22 }, { width: 110 }];
  title(defs, "Definitions");
  header(defs, ["Measure", "Definition"]);
  for (const [k, v] of DOCTOR_PERFORMANCE_DEFINITIONS) defs.addRow([k, v]);
  defs.addRow([]);
  header(defs, ["Threshold", "AED per patient"]);
  defs.addRow(["Target (Achieved)", r.settings.target]);
  defs.addRow(["Near Target from", r.settings.near]);
  defs.addRow(["Moderate from", r.settings.moderate]);
  defs.addRow([]);
  defs.addRow(["Built", input.builtAt]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
