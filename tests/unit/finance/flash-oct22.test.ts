import { describe, expect, it } from "vitest";

import {
  buildFlashSummary,
  daysInMonth,
  monthTargetOf,
  monthTotals,
  parseFlashRows,
  parseOperatingDays,
  periodTargetOf,
  targetFromRow,
  type FlashRow,
  type ReportLine,
  type RevenueTarget,
} from "@/lib/finance/flash";

/**
 * Finance's answers of 22 Oct 2026 (docs/52): revenue per patient over PAID patients (Q6) and the daily target over the
 * branch's operating days (Q7). Synthetic figures only.
 */

const MONTH = "2026-10-01"; // 31 days
const lines: ReportLine[] = [
  {
    code: "SHORE",
    label: "Shoreline",
    matchKind: "branch",
    matchValues: ["S"],
    inCore: true,
    sortOrder: 1,
  },
  {
    code: "GOLD",
    label: "Golden Mile",
    matchKind: "branch",
    matchValues: ["G"],
    inCore: true,
    sortOrder: 2,
  },
  {
    code: "CHIRO",
    label: "Chiro",
    matchKind: "department",
    matchValues: ["Chiro"],
    inCore: false,
    sortOrder: 3,
  },
];
const row = (
  date: string,
  branch: string,
  net: number,
  patients: number,
  paid: number,
  department: string | null = null,
): FlashRow => ({
  date,
  branch,
  department,
  doctorId: "D1",
  doctorName: "Doctor One",
  net,
  patients,
  paidPatients: paid,
  invoices: patients,
});
const target = (
  lineCode: string | null,
  dailyRevenue: number | null,
  operatingDays: number | null,
): RevenueTarget => ({
  month: MONTH,
  lineCode,
  dailyRevenue,
  dailyPatients: null,
  arpp: lineCode === null ? 750 : null,
  operatingDays,
});

describe("Q6: revenue per patient counts paid patients only", () => {
  it("leaves zero-invoice patients out of every ARPP", () => {
    const rows = [
      row("2026-10-05", "S", 3000, 5, 4),
      row("2026-10-05", "G", 900, 3, 2),
      row("2026-10-05", "S", 400, 1, 1, "Chiro"),
    ];
    const s = buildFlashSummary({ rows, lines, targets: [], from: "2026-10-05", to: "2026-10-05" });
    expect(s.lines.find((l) => l.code === "SHORE")).toMatchObject({
      patients: 5,
      paidPatients: 4,
      arpp: 750,
    });
    expect(s.lines.find((l) => l.code === "GOLD")?.arpp).toBe(450);
    expect(s.coreTotal).toMatchObject({ patients: 8, paidPatients: 6, arpp: 650 });
    expect(s.kpis.arpp.actual).toBe(650);
    expect(s.grandTotal.arpp).toBe(Math.round((4300 / 7) * 100) / 100);
    expect(s.doctorSections[0].total.arpp).toBe(650);
  });

  it("reads paid_patients from SQL, and treats a payload without it as all paid", () => {
    expect(
      parseFlashRows({
        rows: [{ date: "2026-10-05", net: 10, patients: 3, paid_patients: 1, invoices: 3 }],
      })[0].paidPatients,
    ).toBe(1);
    expect(
      parseFlashRows({ rows: [{ date: "2026-10-05", net: 10, patients: 3, invoices: 3 }] })[0]
        .paidPatients,
    ).toBe(3);
  });
});

describe("Q7: the daily target over the branch's operating days", () => {
  it("makes the month target daily × operating days (every day when blank)", () => {
    expect(daysInMonth(MONTH)).toBe(31);
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(monthTargetOf(1000, 26, 31)).toBe(26000);
    expect(monthTargetOf(1000, null, 31)).toBe(31000);
    expect(monthTargetOf(null, 26, 31)).toBeNull();
  });

  it("measures one day against the daily target, the month against the month target, part of it pro rata", () => {
    expect(periodTargetOf(26000, 1000, 1, 31)).toBe(1000);
    expect(periodTargetOf(26000, 1000, 31, 31)).toBe(26000);
    expect(periodTargetOf(26000, 1000, 14, 31)).toBeCloseTo((26000 * 14) / 31, 9);
    // without operating days nothing changes: daily × days
    expect(periodTargetOf(31000, 1000, 14, 31)).toBe(14000);
    expect(periodTargetOf(null, 1000, 14, 31)).toBeNull();
  });

  it("sums the core lines' month targets when there is no total row", () => {
    const t = [target("SHORE", 40000, 30), target("GOLD", 8000, 26), target("CHIRO", 999, null)];
    const m = monthTotals(lines, t, MONTH);
    expect(m.revenue).toBe(40000 * 30 + 8000 * 26);
    expect(m.dailyRevenue).toBe(48000);
    const withTotal = monthTotals(lines, [...t, target(null, 45000, 30)], MONTH);
    expect(withTotal.revenue).toBe(45000 * 30);
  });

  it("scores the month to date and each line with the operating days", () => {
    const t = [target("SHORE", 40000, 30), target("GOLD", 8000, 26)];
    const rows = [row("2026-10-05", "S", 3000, 5, 4)];
    const mtd = buildFlashSummary({ rows, lines, targets: t, from: MONTH, to: "2026-10-31" });
    expect(mtd.lines.find((l) => l.code === "GOLD")?.revenue.target).toBe(208000);
    expect(mtd.coreTotal.revenue.target).toBe(1408000);
    const day = buildFlashSummary({
      rows,
      lines,
      targets: t,
      from: "2026-10-05",
      to: "2026-10-05",
    });
    expect(day.lines.find((l) => l.code === "GOLD")?.revenue.target).toBe(8000);
    expect(day.coreTotal.revenue.target).toBe(48000);
  });

  it("parses typed operating days and stored rows defensively", () => {
    expect(parseOperatingDays("", 31)).toBeNull();
    expect(parseOperatingDays(" 26 ", 31)).toBe(26);
    expect(() => parseOperatingDays("31", 30)).toThrow(/between 1 and 30/);
    expect(() => parseOperatingDays("0", 31)).toThrow();
    expect(() => parseOperatingDays("2.5", 31)).toThrow();
    expect(
      targetFromRow({
        month: MONTH,
        line_code: "GOLD",
        daily_revenue: "8000",
        daily_patients: null,
        arpp: null,
        operating_days: 26,
      }).operatingDays,
    ).toBe(26);
    expect(
      targetFromRow({
        month: MONTH,
        line_code: "GOLD",
        daily_revenue: "8000",
        daily_patients: null,
        arpp: null,
      }).operatingDays,
    ).toBeNull();
  });
});
