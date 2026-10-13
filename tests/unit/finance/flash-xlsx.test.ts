import { describe, expect, it } from "vitest";

import {
  buildFlashSummary,
  buildSalesGrid,
  compareGrids,
  type FlashRow,
  type ReportLine,
  type RevenueTarget,
} from "@/lib/finance/flash";
import { flashWorkbook, monthTitle, sheetDate } from "@/lib/finance/flash-xlsx";

import fixture from "./fixtures/flash.synthetic.json";

const lines = fixture.lines as ReportLine[];
const targets = fixture.targets as RevenueTarget[];
const rows = fixture.rows as FlashRow[];
const DAY = "2026-10-12";

describe("flash workbook", () => {
  it("formats dates and months like the clinic's sheets", () => {
    expect(sheetDate(DAY)).toBe("12-10-26");
    expect(monthTitle("2026-09-01")).toBe("September 2026");
  });

  it("has the clinic's sheets with Pulse's own totals and no formulas", async () => {
    const grid = buildSalesGrid({ rows, lines, month: "2026-10-01", asOf: DAY });
    const prevRows = rows.map((r) => ({ ...r, date: "2026-09-12" }));
    const previousGrid = buildSalesGrid({ rows: prevRows, lines, month: "2026-09-01", asOf: "2026-09-12" });
    const buf = await flashWorkbook({
      org: "Synthetic Clinic",
      day: DAY,
      daily: buildFlashSummary({ rows, lines, targets, from: DAY, to: DAY }),
      monthToDate: buildFlashSummary({ rows, lines, targets, from: "2026-10-01", to: DAY }),
      grid,
      previousGrid,
      comparison: compareGrids(grid, previousGrid),
      topDoctors: 5,
      builtAt: "2026-10-13T06:00:00.000Z",
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Daily summary",
      "Month to date",
      "Doctors",
      "Daily sales",
      "Daily sales Sep",
    ]);
    const daily = wb.getWorksheet("Daily summary")!;
    const values: unknown[] = [];
    daily.eachRow((r) => r.eachCell((c) => values.push(c.value)));
    expect(values).toContain(51031);
    expect(values).toContain(58667);
    expect(values).toContain(53121);
    const sales = wb.getWorksheet("Daily sales")!;
    let total: unknown[] = [];
    let formulas = 0;
    for (const ws of wb.worksheets) ws.eachRow((r) => r.eachCell((c) => { if (c.formula) formulas++; }));
    sales.eachRow((r) => {
      if (r.getCell(1).value === "TOTAL") total = (r.values as unknown[]).slice(1);
    });
    expect(total.at(-1)).toBe(53121);
    expect(formulas).toBe(0);
  });
});
