import { SCHEDULE_KIND_LABELS } from "./schedules";
import type { Register, ScheduleStatusRow } from "./register";

/**
 * The fixed asset register, the 12-month depreciation forecast and the schedule status as one .xlsx workbook (Phase
 * 22H). Plain values only (no formulas), so nothing typed into Pulse can run in a spreadsheet. Codes, descriptions,
 * dates and amounts; no patient data exists in these tables.
 */
export type AssetWorkbookInput = {
  org: string;
  asOf: string;
  register: Register;
  forecast: Array<{ month: string; amount: number }>;
  schedules: ScheduleStatusRow[];
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";

export async function assetWorkbook(input: AssetWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(input.builtAt);
  wb.creator = "Pulse";
  const built = `Built ${input.builtAt.slice(0, 16).replace("T", " ")} UTC`;

  const reg = wb.addWorksheet("Fixed asset register");
  reg.columns = [
    { width: 14 },
    { width: 40 },
    { width: 26 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
  ];
  reg.addRow([input.org]).font = { bold: true };
  reg.addRow([`Fixed asset register at ${input.asOf}`]);
  reg.addRow([built]);
  reg.addRow([]);
  reg.addRow([
    "Code",
    "Description",
    "Class",
    "Branch",
    "Acquired",
    "In service",
    "Cost",
    "Accumulated depreciation",
    "Net book value",
    "Status",
  ]).font = { bold: true };
  for (const l of input.register.lines)
    reg.addRow([
      l.code,
      l.description,
      l.className,
      l.branchCode ?? "",
      l.acquisitionDate,
      l.inServiceDate,
      l.cost,
      l.accumulated,
      l.nbv,
      l.status.replace("_", " "),
    ]);
  const t = input.register.total;
  reg.addRow(["", "Total", "", "", "", "", t.cost, t.accumulated, t.nbv, ""]).font = { bold: true };
  reg.addRow([]);
  reg.addRow(["By class"]).font = { bold: true };
  for (const g of input.register.byClass)
    reg.addRow(["", g.label, `${g.count} assets`, "", "", "", g.cost, g.accumulated, g.nbv, ""]);
  reg.addRow([]);
  reg.addRow(["By branch"]).font = { bold: true };
  for (const g of input.register.byBranch)
    reg.addRow(["", g.label, `${g.count} assets`, "", "", "", g.cost, g.accumulated, g.nbv, ""]);
  for (const c of [7, 8, 9]) reg.getColumn(c).numFmt = MONEY;

  const fc = wb.addWorksheet("Depreciation forecast");
  fc.columns = [{ width: 12 }, { width: 18 }];
  fc.addRow([input.org]).font = { bold: true };
  fc.addRow([
    "Depreciation forecast, 12 months (first month includes any catch-up not yet posted)",
  ]);
  fc.addRow([built]);
  fc.addRow([]);
  fc.addRow(["Month", "Depreciation"]).font = { bold: true };
  for (const f of input.forecast) fc.addRow([f.month.slice(0, 7), f.amount]);
  fc.getColumn(2).numFmt = MONEY;

  const sc = wb.addWorksheet("Schedules");
  sc.columns = [
    { width: 18 },
    { width: 40 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 12 },
  ];
  sc.addRow([input.org]).font = { bold: true };
  sc.addRow(["Prepayments, accruals and deferred revenue"]);
  sc.addRow([built]);
  sc.addRow([]);
  sc.addRow([
    "Kind",
    "Description",
    "Branch",
    "From",
    "Months",
    "Total",
    "Released (posted)",
    "Remaining",
    "Status",
  ]).font = { bold: true };
  for (const s of input.schedules)
    sc.addRow([
      SCHEDULE_KIND_LABELS[s.kind] + (s.autoReverse ? " (reversing)" : ""),
      s.description,
      s.branchCode ?? "",
      s.startMonth.slice(0, 7),
      s.months,
      s.total,
      s.released,
      s.remaining,
      s.status,
    ]);
  for (const c of [6, 7, 8]) sc.getColumn(c).numFmt = MONEY;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
