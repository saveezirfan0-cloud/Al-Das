import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  buildScenarioReport,
  defaultInputs,
  type Benchmarks,
  type RecruitmentInputs,
} from "@/lib/finance/recruitment";
import { recruitmentWorkbook, SCENARIO_BANNER } from "@/lib/finance/recruitment-xlsx";

/** The recruitment scenario workbook: banner, values only, figures as stored. Synthetic data. */

const settings = { conservativePct: 70, consumablesPct: 12, gatewayPct: 1.5, minPeerMonths: 6 };
const benchmarks: Benchmarks = {
  settings,
  months: ["2026-08-01", "2026-09-01"],
  departments: [
    { department: "Dermatology", doctorMonths: 8, doctors: 3, median: 60_000, p75: 80_000 },
  ],
  clinic: { department: null, doctorMonths: 20, doctors: 6, median: 55_000, p75: 85_000 },
};
const inputs: RecruitmentInputs = {
  ...defaultInputs(settings),
  department: "Dermatology",
  contractType: "salary_backed_share",
  salary: 20_000,
  sharePct: 40,
  claimedRevenue: 100_000,
  equipmentRevenue: 10_000,
  staffRevenue: 5_000,
  indirect: { visa: { amount: 7_200, months: 24 }, room_rent: { amount: 10_000, months: 1 } },
  setupCost: 30_000,
  startMonth: "2027-01-01",
};

describe("recruitment scenario workbook", () => {
  it("carries the Scenario banner, plain values only and the stored figures", async () => {
    const report = buildScenarioReport(inputs, benchmarks, [
      {
        id: "e1",
        startsOn: "2027-02-08",
        endsOn: "2027-03-09",
        kind: "ramadan",
        label: "Ramadan 1448",
        approximate: true,
      },
    ]);
    const buf = await recruitmentWorkbook({
      org: "Demo Clinic",
      title: "Dermatologist, synthetic branch",
      createdAt: "2026-10-14T09:00:00Z",
      inputs,
      report,
      builtAt: "2026-10-14T10:00:00Z",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Scenario")!;
    expect(ws.getCell("A1").value).toBe(SCENARIO_BANNER);
    const byLabel = new Map<string, unknown>();
    ws.eachRow((row) => {
      row.eachCell((cell) => expect(cell.formula, `${cell.address}`).toBeUndefined());
      byLabel.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    expect(byLabel.get("Profit per month")).toBe(report.result.profitMonthly);
    expect(byLabel.get("Doctor pay")).toBe(29_410); // max(20,000, 40 % of 73,525)
    expect(byLabel.get("Breakeven revenue per month (AED)")).toBeCloseTo(
      report.result.breakeven.revenue!,
      6,
    );
    expect(byLabel.get("Band")).toBe("Band A (at or above the 75th percentile)"); // 85,000 ≥ 80,000
    expect(byLabel.get("Ramadan 1448 (Ramadan)")).toBe("2027-02-08 to 2027-03-09");
  });
});
