import { describe, expect, it } from "vitest";

import {
  assignLine,
  buildFlashSummary,
  buildSalesGrid,
  compareGrids,
  daysInclusive,
  eachDay,
  effectiveLines,
  measure,
  parseFlashRows,
  parseTargetInput,
  pctLabel,
  previousMonthPeriod,
  tone,
  UNASSIGNED,
  type FlashRow,
  type ReportLine,
  type RevenueTarget,
} from "@/lib/finance/flash";

import fixture from "./fixtures/flash.synthetic.json";

/**
 * The fixture reproduces the shape and the figures of the clinic's Daily Financial Summary for one day (branch revenue,
 * patient counts, targets) with invented doctor names. The expected numbers are the ones on the clinic's own sheet, so
 * these tests prove Pulse computes the same KPIs, variances and ARPP from the same inputs.
 */

const lines = fixture.lines as ReportLine[];
const targets = fixture.targets as RevenueTarget[];
const rows = fixture.rows as FlashRow[];
const DAY = "2026-10-12";

describe("assignLine", () => {
  it("puts a department rule before a branch rule", () => {
    const chiroAtPalm: FlashRow = { ...rows[0], branch: "P", department: "Chiropractic" };
    expect(assignLine(chiroAtPalm, lines)).toBe("CHIRO");
  });
  it("matches branch and department case-insensitively and trims", () => {
    expect(assignLine({ ...rows[0], branch: " p ", department: null }, lines)).toBe("PALM");
    expect(assignLine({ ...rows[0], branch: "G", department: " chiropractic " }, lines)).toBe("CHIRO");
  });
  it("sends anything unmatched to UNASSIGNED", () => {
    expect(assignLine({ ...rows[0], branch: "ZZ", department: "Other" }, lines)).toBe(UNASSIGNED);
    expect(assignLine({ ...rows[0], branch: null, department: null }, lines)).toBe(UNASSIGNED);
  });
});

describe("effectiveLines", () => {
  it("derives one core line per branch when nothing is configured", () => {
    const derived = effectiveLines([], rows);
    expect(derived.map((l) => l.code)).toEqual(["D", "G", "L", "M", "P"].filter((b) => rows.some((r) => r.branch === b)));
    expect(derived.every((l) => l.inCore && l.matchKind === "branch")).toBe(true);
  });
  it("sorts configured lines by sort order", () => {
    const shuffled = [...lines].reverse();
    expect(effectiveLines(shuffled, rows).map((l) => l.code)).toEqual(lines.map((l) => l.code));
  });
});

describe("daily summary (matches the clinic's sheet for 12 Oct)", () => {
  const s = buildFlashSummary({ rows, lines, targets, from: DAY, to: DAY });

  it("computes the KPIs", () => {
    expect(s.kpis.revenue).toMatchObject({ actual: 51031, target: 58667, variance: -7636 });
    expect(pctLabel(s.kpis.revenue.variancePct)).toBe("-13%");
    expect(s.kpis.patients).toMatchObject({ actual: 64, target: 78, variance: -14 });
    expect(pctLabel(s.kpis.patients.variancePct)).toBe("-18%");
    expect(Math.round(s.kpis.arpp.actual)).toBe(797);
    expect(s.kpis.arpp.target).toBe(750);
    expect(Math.round(s.kpis.arpp.variance!)).toBe(47);
    expect(pctLabel(s.kpis.arpp.variancePct)).toBe("6%");
  });

  it("computes branch revenue, variance, patients and ARPP", () => {
    const by = Object.fromEntries(s.lines.map((l) => [l.code, l]));
    expect(by.PALM.revenue.actual).toBe(23588);
    expect(pctLabel(by.PALM.revenue.variancePct)).toBe("-28%");
    expect(by.PALM.patients).toBe(32);
    expect(Math.round(by.PALM.arpp!)).toBe(737);
    expect(pctLabel(by.GM.revenue.variancePct)).toBe("-71%");
    expect(by.GM.arpp).toBe(1360);
    expect(pctLabel(by.MTC.revenue.variancePct)).toBe("87%");
    expect(Math.round(by.MTC.arpp!)).toBe(839);
    expect(pctLabel(by.LONGEVITY.revenue.variancePct)).toBe("-89%");
    expect(s.coreTotal.revenue.actual).toBe(51031);
    expect(s.coreTotal.patients).toBe(64);
  });

  it("keeps Chiro and the leased unit out of the core total but in the grand total", () => {
    expect(s.otherLines.map((l) => l.code)).toEqual(["CHIRO", "DENTAL"]);
    expect(s.otherLines[0].revenue.actual).toBe(2090);
    expect(s.otherLines[1].revenue.actual).toBe(0);
    expect(s.grandTotal.revenue).toBe(53121);
    expect(s.grandTotal.patients).toBe(67);
  });

  it("ranks doctors with share of the section total by default", () => {
    const core = s.doctorSections.find((d) => d.code === "CORE")!;
    expect(core.doctors.map((d) => d.name)).toEqual([
      "Dr Test Alpha",
      "Dr Test Bravo",
      "Dr Test Charlie",
      "Dr Test Delta",
      "Dr Test Echo",
      "Dr Test Foxtrot",
      "Dr Test Golf",
      "Dr Test Hotel",
    ]);
    expect(core.doctors[0]).toMatchObject({ rank: 1, revenue: 15232, patients: 20 });
    expect(pctLabel(core.doctors[0].share)).toBe("30%");
    expect(core.total).toMatchObject({ revenue: 51031, patients: 64 });
    const chiro = s.doctorSections.find((d) => d.code === "CHIRO")!;
    expect(chiro.doctors).toHaveLength(1);
    expect(pctLabel(chiro.doctors[0].share)).toBe("100%");
  });

  it("can divide doctor shares by the grand total instead", () => {
    const all = buildFlashSummary({ rows, lines, targets, from: DAY, to: DAY, shareBasis: "all" });
    const chiro = all.doctorSections.find((d) => d.code === "CHIRO")!;
    expect(pctLabel(chiro.doctors[0].share)).toBe("4%");
  });

  it("limits the doctor list when asked (top 5)", () => {
    const top = buildFlashSummary({ rows, lines, targets, from: DAY, to: DAY, topDoctors: 5 });
    const core = top.doctorSections.find((d) => d.code === "CORE")!;
    expect(core.doctors).toHaveLength(5);
    expect(core.total.revenue).toBe(51031); // totals still cover every doctor
  });

  it("has no warnings when everything is assigned and targeted", () => {
    expect(s.warnings).toEqual([]);
  });
});

describe("month to date", () => {
  const monthRows: FlashRow[] = eachDay("2026-10-01", DAY).map((date) => ({
    ...rows[0],
    date,
  }));
  const s = buildFlashSummary({
    rows: monthRows,
    lines,
    targets: [...targets.filter((t) => t.lineCode !== null), { ...targets.find((t) => t.lineCode === null)!, dailyPatients: 78.25 }],
    from: "2026-10-01",
    to: DAY,
  });

  it("scales targets by calendar days elapsed (as the clinic's sheet does)", () => {
    expect(s.days).toBe(12);
    const palm = s.lines.find((l) => l.code === "PALM")!;
    expect(palm.revenue.target).toBe(391116);
    expect(s.kpis.revenue.target).toBe(704004);
    expect(s.kpis.patients.target).toBe(939);
    expect(s.kpis.arpp.target).toBe(750); // a rate, not scaled
  });

  it("ignores rows outside the period", () => {
    const withNovember = [...monthRows, { ...rows[0], date: "2026-11-01", net: 99999 }];
    const again = buildFlashSummary({ rows: withNovember, lines, targets, from: "2026-10-01", to: DAY });
    expect(again.grandTotal.revenue).toBe(s.grandTotal.revenue);
  });
});

describe("warnings and edge cases", () => {
  it("reports unassigned revenue and counts it in the core total", () => {
    const extra: FlashRow = { ...rows[0], branch: "ZZ", department: null, net: 100, patients: 1 };
    const s = buildFlashSummary({ rows: [...rows, extra], lines, targets, from: DAY, to: DAY });
    expect(s.lines.at(-1)!.code).toBe(UNASSIGNED);
    expect(s.coreTotal.revenue.actual).toBe(51131);
    expect(s.warnings.join(" ")).toMatch(/matches no reporting line/);
  });

  it("reports revenue without a doctor", () => {
    const extra: FlashRow = { ...rows[0], doctorId: null, doctorName: null, net: 50 };
    const s = buildFlashSummary({ rows: [...rows, extra], lines, targets, from: DAY, to: DAY });
    expect(s.warnings.join(" ")).toMatch(/no doctor/);
    expect(s.doctorSections[0].doctors.some((d) => d.name === "No doctor on invoice")).toBe(true);
  });

  it("works with no targets and no rows", () => {
    const s = buildFlashSummary({ rows: [], lines, targets: [], from: DAY, to: DAY });
    expect(s.kpis.revenue).toEqual({ actual: 0, target: null, variance: null, variancePct: null });
    expect(s.kpis.arpp.actual).toBe(0);
    expect(s.warnings).toContain("No revenue target is set for this month.");
    expect(s.warnings).toContain("No invoices in this period yet.");
  });

  it("uses an explicit total target over the sum of the lines", () => {
    const t: RevenueTarget[] = [...targets.filter((x) => x.lineCode !== null), { month: "2026-10-01", lineCode: null, dailyRevenue: 60000, dailyPatients: null, arpp: null }];
    const s = buildFlashSummary({ rows, lines, targets: t, from: DAY, to: DAY });
    expect(s.kpis.revenue.target).toBe(60000);
    expect(s.kpis.patients.target).toBeNull();
  });

  it("ignores another month's targets", () => {
    const t = targets.map((x) => ({ ...x, month: "2026-09-01" }));
    const s = buildFlashSummary({ rows, lines, targets: t, from: DAY, to: DAY });
    expect(s.kpis.revenue.target).toBeNull();
  });

  it("refuses a period that crosses months or is empty", () => {
    expect(() => buildFlashSummary({ rows, lines, targets, from: "2026-09-30", to: "2026-10-01" })).toThrow();
    expect(() => buildFlashSummary({ rows, lines, targets, from: DAY, to: "2026-10-11" })).toThrow();
    expect(() => buildFlashSummary({ rows, lines, targets, from: "bad", to: DAY })).toThrow();
  });
});

describe("daily sales grid", () => {
  const grid = buildSalesGrid({ rows, lines, month: "2026-10-01", asOf: DAY });

  it("has one row per calendar day and one column per line (core first)", () => {
    expect(grid.days).toHaveLength(12);
    expect(grid.columns.map((c) => c.code)).toEqual(["PALM", "GM", "MTC", "LONGEVITY", "CHIRO", "DENTAL"]);
    expect(grid.days[0].total).toBe(0);
    const last = grid.days.at(-1)!;
    expect(last.values).toEqual([23588, 2720, 24341, 382, 2090, 0]);
    expect(last.total).toBe(53121);
  });

  it("totals add up across and down (no hand-typed totals to drift)", () => {
    expect(grid.grandTotal).toBe(grid.days.reduce((a, d) => a + d.total, 0));
    expect(grid.totals.reduce((a, b) => a + b, 0)).toBe(grid.grandTotal);
    expect(pctLabel(grid.shares[0])).toBe("44%");
  });

  it("adds an Unassigned column only when needed", () => {
    const g = buildSalesGrid({
      rows: [...rows, { ...rows[0], branch: "ZZ", department: null }],
      lines,
      month: "2026-10-01",
      asOf: DAY,
    });
    expect(g.columns.at(-1)!.code).toBe(UNASSIGNED);
  });

  it("refuses a day outside the month", () => {
    expect(() => buildSalesGrid({ rows, lines, month: "2026-10-01", asOf: "2026-11-01" })).toThrow();
    expect(() => buildSalesGrid({ rows, lines, month: "2026-10-05", asOf: DAY })).toThrow();
  });
});

describe("helpers", () => {
  it("measure handles missing and zero targets", () => {
    expect(measure(10, null).variancePct).toBeNull();
    expect(measure(10, 0)).toMatchObject({ variance: 10, variancePct: null });
  });
  it("counts days and lists them", () => {
    expect(daysInclusive("2026-10-01", "2026-10-31")).toBe(31);
    expect(daysInclusive("2026-10-02", "2026-10-01")).toBe(0);
    expect(eachDay("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
  it("parses SQL rows defensively", () => {
    expect(parseFlashRows(null)).toEqual([]);
    expect(parseFlashRows({ rows: [{ date: "x" }] })).toEqual([]);
    expect(
      parseFlashRows({ rows: [{ date: DAY, net: "12.5", patients: "2", invoices: 3, branch: "", doctor_id: "D1" }] }),
    ).toEqual([
      { date: DAY, branch: null, department: null, doctorId: "D1", doctorName: null, net: 12.5, patients: 2, invoices: 3 },
    ]);
  });
  it("labels and tones", () => {
    expect(pctLabel(null)).toBe("");
    expect(pctLabel(0.874)).toBe("87%");
    expect(tone(0.1)).toBe("good");
    expect(tone(-0.1)).toBe("bad");
    expect(tone(0)).toBe("neutral");
    expect(tone(null)).toBe("neutral");
  });
  it("parses target inputs strictly", () => {
    expect(parseTargetInput("")).toBeNull();
    expect(parseTargetInput("32,593")).toBe(32593);
    expect(parseTargetInput("78.25")).toBe(78.25);
    expect(() => parseTargetInput("0")).toThrow();
    expect(() => parseTargetInput("-5")).toThrow();
    expect(() => parseTargetInput("1.234")).toThrow();
    expect(() => parseTargetInput("abc")).toThrow();
  });
});

describe("comparison with the same days of last month", () => {
  it("finds the same stretch of the previous month, clamped to its length", () => {
    expect(previousMonthPeriod("2026-10-12")).toEqual({ month: "2026-09-01", asOf: "2026-09-12" });
    expect(previousMonthPeriod("2026-03-31")).toEqual({ month: "2026-02-01", asOf: "2026-02-28" });
    expect(previousMonthPeriod("2028-03-30")).toEqual({ month: "2028-02-01", asOf: "2028-02-29" });
    expect(previousMonthPeriod("2026-01-15")).toEqual({ month: "2025-12-01", asOf: "2025-12-15" });
    expect(previousMonthPeriod("nope")).toBeNull();
  });

  it("compares column by column and in total", () => {
    const current = buildSalesGrid({ rows, lines, month: "2026-10-01", asOf: DAY });
    const septRows = rows.map((r) => ({ ...r, date: "2026-09-12", net: r.net / 2 }));
    const previous = buildSalesGrid({ rows: septRows, lines, month: "2026-09-01", asOf: "2026-09-12" });
    const cmp = compareGrids(current, previous);
    const palm = cmp.rows.find((r) => r.code === "PALM")!;
    expect(palm).toMatchObject({ current: 23588, previous: 11794, change: 11794 });
    expect(pctLabel(palm.changePct)).toBe("100%");
    expect(cmp.rows.find((r) => r.code === "DENTAL")!.changePct).toBeNull(); // nothing last month
    expect(cmp.total).toMatchObject({ current: 53121, previous: 26560.5 });
  });

  it("keeps a line that only existed last month", () => {
    const current = buildSalesGrid({ rows: [], lines: lines.slice(0, 1), month: "2026-10-01", asOf: DAY });
    const previous = buildSalesGrid({ rows, lines, month: "2026-10-01", asOf: DAY });
    const cmp = compareGrids(current, previous);
    expect(cmp.rows.map((r) => r.code)).toContain("MTC");
    expect(cmp.rows.find((r) => r.code === "MTC")!.current).toBe(0);
  });
});
