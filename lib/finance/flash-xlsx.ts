import type { FlashSummary, GridComparison, LineResult, Measure, SalesGrid } from "@/lib/finance/flash";

/**
 * The flash report as an .xlsx workbook laid out like the clinic's own sheets: "Daily summary", "Month to date",
 * "Doctors" and "Daily sales". Every cell is a plain value (no formulas), so nothing typed into Pulse can run in a
 * spreadsheet, and the totals are Pulse's own (they cannot drift from the rows).
 */

export type FlashWorkbookInput = {
  org: string;
  day: string;
  daily: FlashSummary;
  monthToDate: FlashSummary;
  grid: SalesGrid;
  previousGrid?: SalesGrid | null;
  comparison?: GridComparison | null;
  topDoctors: number;
  builtAt: string;
};

const MONEY = "#,##0;[Red](#,##0)";
const PCT = "0%;[Red]-0%";

/** "12-10-26": the date format the clinic's sheets use. */
export function sheetDate(iso: string): string {
  return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(2, 4)}`;
}

export function monthTitle(month: string): string {
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names[Number(month.slice(5, 7)) - 1] ?? ""} ${month.slice(0, 4)}`;
}

export async function flashWorkbook(input: FlashWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const title = (ws: Sheet, text: string) => {
    const r = ws.addRow([text]);
    r.font = { bold: true, size: 13 };
  };
  const header = (ws: Sheet, cells: string[]) => {
    const r = ws.addRow(cells);
    r.font = { bold: true };
    r.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
    });
  };
  const fmt = (ws: Sheet, rowNo: number, cols: number[], numFmt: string) => {
    for (const c of cols) ws.getRow(rowNo).getCell(c).numFmt = numFmt;
  };
  const kpiRow = (ws: Sheet, label: string, m: Measure) => {
    const r = ws.addRow([label, m.actual, m.target ?? "", m.variance ?? "", m.variancePct ?? ""]);
    fmt(ws, r.number, [2, 3, 4], MONEY);
    fmt(ws, r.number, [5], PCT);
  };
  const lineRow = (ws: Sheet, l: LineResult) => {
    const r = ws.addRow([
      l.label,
      l.revenue.actual,
      l.revenue.target ?? "",
      l.revenue.variancePct ?? "",
      l.patients,
      l.arpp ?? "",
    ]);
    fmt(ws, r.number, [2, 3, 6], MONEY);
    fmt(ws, r.number, [4], PCT);
    return r;
  };

  const summarySheet = (name: string, heading: string, s: FlashSummary) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ width: 38 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }];
    title(ws, input.org);
    title(ws, heading);
    ws.addRow([]);
    header(ws, ["Key performance indicators", "Actual", "Target", "Variance", "Variance %"]);
    kpiRow(ws, "Net revenue", s.kpis.revenue);
    kpiRow(ws, "Patient volume", s.kpis.patients);
    kpiRow(ws, "ARPP", s.kpis.arpp);
    ws.addRow([]);
    header(ws, ["Branch revenue (excl. Chiro)", "Revenue (AED)", "Target", "Variance %", "Patients", "ARPP"]);
    for (const l of s.lines) lineRow(ws, l);
    lineRow(ws, { ...s.coreTotal, label: "Total revenue (excl. Chiro)" }).font = { bold: true };
    for (const l of s.otherLines) lineRow(ws, l);
    const g = ws.addRow(["Total revenue (all lines)", s.grandTotal.revenue, "", "", s.grandTotal.patients, s.grandTotal.arpp ?? ""]);
    g.font = { bold: true };
    fmt(ws, g.number, [2, 6], MONEY);
    ws.addRow([]);
    const core = s.doctorSections.find((d) => d.code === "CORE");
    if (core) {
      header(ws, [`Top ${input.topDoctors} doctors`, "Revenue", "Patients", "ARPP", "% of total"]);
      for (const d of core.doctors.slice(0, input.topDoctors)) {
        const r = ws.addRow([`${d.rank}. ${d.name}`, d.revenue, d.patients, d.arpp ?? "", d.share ?? ""]);
        fmt(ws, r.number, [2, 4], MONEY);
        fmt(ws, r.number, [5], PCT);
      }
    }
    if (s.warnings.length > 0) {
      ws.addRow([]);
      for (const w of s.warnings) ws.addRow([`Note: ${w}`]).font = { italic: true };
    }
    return ws;
  };

  summarySheet(
    "Daily summary",
    `Daily financial summary, ${sheetDate(input.day)}`,
    input.daily,
  );
  summarySheet(
    "Month to date",
    `Monthly revenue summary, ${monthTitle(input.grid.month)}, as on ${sheetDate(input.day)}`,
    input.monthToDate,
  );

  // Doctors: the full ranking for the day and month to date, one block per section
  const docs = wb.addWorksheet("Doctors");
  docs.columns = [{ width: 8 }, { width: 38 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 12 }];
  for (const [label, s] of [
    [`Day, ${sheetDate(input.day)}`, input.daily],
    [`Month to date, ${monthTitle(input.grid.month)}`, input.monthToDate],
  ] as const) {
    for (const section of s.doctorSections) {
      title(docs, `Doctor performance (${section.label}), ${label}`);
      header(docs, ["Rank", "Doctor", "Revenue", "Patients", "ARPP", "% of total"]);
      for (const d of section.doctors) {
        const r = docs.addRow([d.rank, d.name, d.revenue, d.patients, d.arpp ?? "", d.share ?? ""]);
        fmt(docs, r.number, [3, 5], MONEY);
        fmt(docs, r.number, [6], PCT);
      }
      const t = docs.addRow(["", "Total", section.total.revenue, section.total.patients, section.total.arpp ?? "", section.total.share ?? ""]);
      t.font = { bold: true };
      fmt(docs, t.number, [3, 5], MONEY);
      fmt(docs, t.number, [6], PCT);
      docs.addRow([]);
    }
  }

  // Daily sales grids (this month, then the same days of last month) and the comparison
  const weekday = (iso: string) =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      new Date(`${iso}T00:00:00Z`).getUTCDay()
    ];
  const gridSheet = (name: string, g: SalesGrid) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ width: 12 }, { width: 12 }, ...g.columns.map(() => ({ width: 14 })), { width: 14 }];
    title(ws, `${input.org}: daily sales summary, ${monthTitle(g.month)}`);
    header(ws, ["Date", "Day", ...g.columns.map((c) => c.label), "Total"]);
    const moneyCols = g.columns.map((_, i) => i + 3).concat(g.columns.length + 3);
    for (const d of g.days) {
      const r = ws.addRow([sheetDate(d.date), weekday(d.date), ...d.values, d.total]);
      fmt(ws, r.number, moneyCols, MONEY);
    }
    const tot = ws.addRow(["TOTAL", "", ...g.totals, g.grandTotal]);
    tot.font = { bold: true };
    fmt(ws, tot.number, moneyCols, MONEY);
    const share = ws.addRow(["%", "", ...g.shares.map((v) => v ?? ""), ""]);
    fmt(ws, share.number, moneyCols, PCT);
    return ws;
  };
  const current = gridSheet("Daily sales", input.grid);
  if (input.previousGrid) gridSheet(`Daily sales ${monthTitle(input.previousGrid.month).slice(0, 3)}`, input.previousGrid);
  if (input.comparison && input.previousGrid) {
    current.addRow([]);
    title(current, `Against ${monthTitle(input.previousGrid.month)}, same days`);
    header(current, ["Line", "", monthTitle(input.grid.month), monthTitle(input.previousGrid.month), "Change", "Change %"]);
    for (const r of [...input.comparison.rows, { label: "Total", ...input.comparison.total }]) {
      const row = current.addRow([r.label, "", r.current, r.previous, r.change, r.changePct ?? ""]);
      fmt(current, row.number, [3, 4, 5], MONEY);
      fmt(current, row.number, [6], PCT);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
