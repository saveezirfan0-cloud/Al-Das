/**
 * M1 management alerts (docs/23_PHASE_23E_NOTES.md): the pure rules. Synthetic data only (Dr Demo-NN, made-up branch
 * codes and amounts).
 */
import { describe, expect, it } from "vitest";

import {
  buildDoctorPerformance,
  parseDoctorPerformanceInputs,
} from "@/lib/finance/doctor-performance";
import type { FlashRow, ReportLine, RevenueTarget } from "@/lib/finance/flash";
import {
  alertTransitions,
  bandBelowMessage,
  coveredDays,
  DEFAULT_MGMT_ALERT_SETTINGS,
  doctorsBelowBand,
  isBehind,
  mgmtAlertSettingsFromRow,
  mgmtAlertSettingsSchema,
  parseMgmtAlertInputs,
  reportIsLate,
  reportLateMessage,
  revenueBehindMessage,
  revenueBehindScopes,
  revenueProgress,
  type AlertKey,
} from "@/lib/finance/management-alerts";

const MONTH = "2026-10-01";

// ---------------------------------------------------------------------------
describe("settings", () => {
  it("falls back to the table defaults without a row or with blank values", () => {
    expect(mgmtAlertSettingsFromRow(null)).toEqual(DEFAULT_MGMT_ALERT_SETTINGS);
    expect(
      mgmtAlertSettingsFromRow({
        alert_report_late_days: 5,
        alert_revenue_target_pct: "85.50",
        alert_revenue_target_days: null,
        alert_band_min_patients: "",
      }),
    ).toEqual({
      reportLateDays: 5,
      revenueTargetPct: 85.5,
      revenueTargetDays: 3,
      bandMinPatients: 10,
    });
  });

  it("validates the form with the database limits", () => {
    const ok = {
      alert_report_late_days: "3",
      alert_revenue_target_pct: "90.25",
      alert_revenue_target_days: "3",
      alert_band_min_patients: "10",
    };
    expect(mgmtAlertSettingsSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { alert_report_late_days: "0" },
      { alert_report_late_days: "61" },
      { alert_report_late_days: "2.5" },
      { alert_revenue_target_pct: "0" },
      { alert_revenue_target_pct: "100.01" },
      { alert_revenue_target_pct: "90.125" },
      { alert_revenue_target_days: "32" },
      { alert_band_min_patients: "0" },
      { alert_band_min_patients: "abc" },
    ])
      expect(
        mgmtAlertSettingsSchema.safeParse({ ...ok, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Unite report late", () => {
  const today = "2026-10-14"; // the last 3 days are 11, 12 and 13 October
  it("is late only when no committed upload covers any of the last N days", () => {
    expect(reportIsLate({ today, lastCovered: "2026-10-13", lateDays: 3 })).toBe(false);
    expect(reportIsLate({ today, lastCovered: "2026-10-11", lateDays: 3 })).toBe(false); // exactly at the edge
    expect(reportIsLate({ today, lastCovered: "2026-10-10", lateDays: 3 })).toBe(true);
    expect(reportIsLate({ today, lastCovered: "2026-10-10", lateDays: 4 })).toBe(false);
  });

  it("stays quiet before the first upload ever, and on unreadable data", () => {
    expect(reportIsLate({ today, lastCovered: null, lateDays: 3 })).toBe(false);
    expect(reportIsLate({ today, lastCovered: "not a date", lateDays: 3 })).toBe(false);
    expect(reportIsLate({ today, lastCovered: "2026-01-01", lateDays: 0 })).toBe(false);
  });

  it("clears as soon as an upload covering a recent day is committed", () => {
    expect(reportIsLate({ today, lastCovered: "2026-10-01", lateDays: 3 })).toBe(true);
    expect(reportIsLate({ today, lastCovered: "2026-10-12", lateDays: 3 })).toBe(false);
  });

  it("says nothing but the number of days", () => {
    expect(reportLateMessage(3).body).toBe(
      "No committed upload covers any of the last 3 days. Open Finance, Upload to add it.",
    );
  });
});

// ---------------------------------------------------------------------------
const row = (
  date: string,
  branch: string | null,
  net: number,
  department: string | null = "Derma",
): FlashRow => ({
  date,
  branch,
  department,
  doctorId: null,
  doctorName: null,
  net,
  patients: 0,
  invoices: 0,
});
const line = (
  code: string,
  matchKind: "branch" | "department",
  values: string[],
  inCore = true,
): ReportLine => ({ code, label: code, matchKind, matchValues: values, inCore, sortOrder: 0 });
const target = (lineCode: string | null, dailyRevenue: number | null): RevenueTarget => ({
  month: MONTH,
  lineCode,
  dailyRevenue,
  dailyPatients: null,
  arpp: null,
});
const LINES = [
  line("BRA", "branch", ["BA"]),
  line("BRB", "branch", ["BB"]),
  line("CHIRO", "department", ["Chiro"], false),
];
const days = (from: number, to: number) => {
  const out: string[] = [];
  for (let d = from; d <= to; d++) out.push(`2026-10-${String(d).padStart(2, "0")}`);
  return out;
};
const cov = (...r: [number, number][]) =>
  r.map(([f, t]) => ({ from: days(f, f)[0], to: days(t, t)[0] }));

describe("revenue behind target", () => {
  it("is not behind exactly at the threshold, and behind one fil below it", () => {
    expect(isBehind(900, 1000, 90)).toBe(false);
    expect(isBehind(899.99, 1000, 90)).toBe(true);
    expect(isBehind(902.25, 1002.5, 90)).toBe(false); // 90% of 1002.50 = 902.25 exactly
    expect(isBehind(0, 0, 90)).toBe(false);
  });

  it("scales the target by covered days, not calendar days (a gap does not count against revenue)", () => {
    const rows = [...days(1, 2), ...days(6, 7)].map((d) => row(d, "BA", 900));
    const p = revenueProgress({
      month: MONTH,
      rows,
      lines: LINES,
      targets: [target(null, 1000)],
      coverage: cov([1, 2], [6, 7]),
    });
    const total = p.find((x) => x.scope === "total")!;
    expect(total.points.map((x) => x.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(total.points.at(-1)).toEqual({ day: "2026-10-07", actual: 3600, target: 4000 });
    // 90% exactly on every covered day: not behind
    expect(revenueBehindScopes(p, 90, 3)).toEqual([]);
    expect(revenueBehindScopes(p, 90.01, 3)).toEqual(["total"]);
  });

  it("needs the last N covered days behind in a row (a partial month with fewer covered days: no alert)", () => {
    const targets = [target(null, 1000)];
    const twoDays = revenueProgress({
      month: MONTH,
      rows: days(1, 2).map((d) => row(d, "BA", 100)),
      lines: LINES,
      targets,
      coverage: cov([1, 2]),
    });
    expect(revenueBehindScopes(twoDays, 90, 3)).toEqual([]);
    expect(revenueBehindScopes(twoDays, 90, 2)).toEqual(["total"]);

    // A strong first day keeps the month to date above 90% on day 2; behind only from day 3.
    const rows = [row("2026-10-01", "BA", 2500), ...days(2, 5).map((d) => row(d, "BA", 500))];
    const p = revenueProgress({ month: MONTH, rows, lines: LINES, targets, coverage: cov([1, 5]) });
    // cumulative: 2500/1000, 3000/2000, 3500/3000, 4000/4000, 4500/5000
    expect(revenueBehindScopes(p, 90, 3)).toEqual([]); // day 3 at 116%, day 4 at 100%
    expect(revenueBehindScopes(p, 90, 1)).toEqual([]); // day 5 at exactly 90%
    expect(revenueBehindScopes(p, 95, 1)).toEqual(["total"]);
  });

  it("clears when the month to date recovers on the latest covered day", () => {
    const targets = [target(null, 1000)];
    const behind = days(1, 3).map((d) => row(d, "BA", 500));
    const p1 = revenueProgress({
      month: MONTH,
      rows: behind,
      lines: LINES,
      targets,
      coverage: cov([1, 3]),
    });
    expect(revenueBehindScopes(p1, 90, 3)).toEqual(["total"]);
    const recovered = [...behind, row("2026-10-04", "BA", 2700)]; // 4200 / 4000
    const p2 = revenueProgress({
      month: MONTH,
      rows: recovered,
      lines: LINES,
      targets,
      coverage: cov([1, 4]),
    });
    expect(revenueBehindScopes(p2, 90, 3)).toEqual([]);
  });

  it("checks each branch line with a target; department lines take their rows first (flash rules)", () => {
    const rows = days(1, 3).flatMap((d) => [
      row(d, "BA", 700),
      row(d, "BA", 300, "Chiro"), // goes to the Chiro line, not to branch A
      row(d, "BB", 450),
    ]);
    const p = revenueProgress({
      month: MONTH,
      rows,
      lines: LINES,
      targets: [target("BRA", 1000), target("BRB", 500), target("CHIRO", 100)],
      coverage: cov([1, 3]),
    });
    // no explicit total row: the total target is the sum of the core lines' targets (1500 a day)
    expect(p.map((x) => x.scope).sort()).toEqual(["line:BRA", "line:BRB", "total"]);
    expect(p.find((x) => x.scope === "line:BRA")!.points.at(-1)).toEqual({
      day: "2026-10-03",
      actual: 2100,
      target: 3000,
    });
    // A: 70%, B: 90% exactly, total (core lines A + B): 1150/1500 = 76.7%
    expect(revenueBehindScopes(p, 90, 3).sort()).toEqual(["line:BRA", "total"]);
  });

  it("skips silently with no target, no lines with targets, or no covered data", () => {
    const rows = days(1, 3).map((d) => row(d, "BA", 1));
    expect(
      revenueProgress({ month: MONTH, rows, lines: LINES, targets: [], coverage: cov([1, 3]) }),
    ).toEqual([]);
    expect(
      revenueProgress({
        month: MONTH,
        rows,
        lines: [],
        targets: [target(null, 1000)],
        coverage: [],
      }),
    ).toEqual([]);
    // coverage outside the month is ignored
    expect(coveredDays(MONTH, [{ from: "2026-09-29", to: "2026-10-02" }])).toEqual([
      "2026-10-01",
      "2026-10-02",
    ]);
    // covered days without any rows: revenue is 0, so the scope is behind
    const p = revenueProgress({
      month: MONTH,
      rows: [],
      lines: [],
      targets: [target(null, 1000)],
      coverage: cov([1, 3]),
    });
    expect(revenueBehindScopes(p, 90, 3)).toEqual(["total"]);
  });

  it("describes the scopes with counts only", () => {
    const m = revenueBehindMessage(["total", "line:BRA", "line:BRB"], {
      revenueTargetPct: 90,
      revenueTargetDays: 3,
    });
    expect(m.body).toContain("the total and 2 branch lines");
    expect(m.body).not.toMatch(/BRA|BRB|AED/);
  });

  it("parses the SQL inputs and ignores malformed rows", () => {
    const i = parseMgmtAlertInputs({
      month: "2026-10-01",
      last_covered: "2026-10-12",
      coverage: [
        { from: "2026-10-01", to: "2026-10-12" },
        { from: "bad", to: "2026-10-12" },
      ],
      rows: [
        { date: "2026-10-01", branch: "BA", department: "Derma", net: "12.345" },
        { date: "nope", branch: "BA", net: 1 },
      ],
    });
    expect(i.lastCovered).toBe("2026-10-12");
    expect(i.coverage).toHaveLength(1);
    expect(i.rows).toEqual([row("2026-10-01", "BA", 12.345)]);
    expect(parseMgmtAlertInputs(null)).toEqual({
      month: "",
      lastCovered: null,
      coverage: [],
      rows: [],
    });
  });
});

// ---------------------------------------------------------------------------
type Doc = { department: string; key: string; revenue: number; patients: number };
const perf = (docs: Doc[], coverage = [{ from: "2026-09-01", to: "2026-09-30" }]) =>
  buildDoctorPerformance(
    parseDoctorPerformanceInputs({
      month: "2026-09-01",
      previous_month: "2026-08-01",
      coverage,
      previous_coverage: [],
      settings: { target: 750, near: 700, moderate: 650 },
      current: {
        doctors: docs.map((d) => ({
          department: d.department,
          doctor_key: d.key,
          doctor_name: d.key,
          revenue: d.revenue,
          visits: d.patients,
          patients: d.patients,
        })),
        departments: [],
        total: { revenue: docs.reduce((s, d) => s + d.revenue, 0), visits: 1, patients: 1 },
      },
      previous: {},
    }),
  );

describe("revenue per patient below band", () => {
  it("counts doctors Below Target with at least the minimum patients, judged by bandOf", () => {
    const report = perf([
      { department: "Derma", key: "dr demo 01", revenue: 6499.9, patients: 10 }, // 649.99: Below, 10 patients
      { department: "Derma", key: "dr demo 02", revenue: 6500, patients: 10 }, // exactly 650: Moderate
      { department: "Derma", key: "dr demo 03", revenue: 900, patients: 9 }, // Below but only 9 patients
      { department: "Physio", key: "dr demo 04", revenue: 5000, patients: 20 }, // 250: Below
      { department: "Ortho", key: "dr demo 04", revenue: 1000, patients: 10 }, // the same doctor again: counted once
      { department: "Ortho", key: "dr demo 05", revenue: 9000, patients: 12 }, // 750: Achieved
    ]);
    expect(doctorsBelowBand(report, 10)).toBe(2);
    expect(doctorsBelowBand(report, 9)).toBe(3);
    expect(doctorsBelowBand(report, 21)).toBe(0);
  });

  it("waits until the month is fully covered by committed report data", () => {
    const docs = [{ department: "Derma", key: "dr demo 01", revenue: 100, patients: 10 }];
    expect(doctorsBelowBand(perf(docs, [{ from: "2026-09-01", to: "2026-09-29" }]), 10)).toBeNull();
    expect(doctorsBelowBand(perf(docs, []), 10)).toBeNull();
    expect(doctorsBelowBand(perf(docs), 10)).toBe(1);
  });

  it("names nobody: a count and the month", () => {
    expect(bandBelowMessage(3, "2026-09-01").body).toBe(
      "3 doctors were below the revenue-per-patient band in September 2026.",
    );
    expect(bandBelowMessage(1, "2026-09-01").body).toBe(
      "1 doctor was below the revenue-per-patient band in September 2026.",
    );
  });
});

// ---------------------------------------------------------------------------
describe("transitions (one alert per rule, scope and period until it clears)", () => {
  const late: AlertKey = { rule: "report_late", scope: "all", period: "-" };
  const total: AlertKey = { rule: "revenue_behind", scope: "total", period: "2026-10" };
  const branch: AlertKey = { rule: "revenue_behind", scope: "line:BRA", period: "2026-10" };
  const band: AlertKey = { rule: "band_below", scope: "all", period: "2026-09" };
  const all = new Set(["report_late", "revenue_behind", "band_below"] as const);

  it("raises only what is not already open", () => {
    expect(alertTransitions([late, total, total], [], all)).toEqual({
      raise: [late, total],
      clear: [],
    });
    expect(alertTransitions([late, total, branch], [late, total], all)).toEqual({
      raise: [branch],
      clear: [],
    });
  });

  it("clears an open alert whose condition stopped, and a new month's alert is a new key", () => {
    const lastMonth: AlertKey = { ...total, period: "2026-09" };
    expect(alertTransitions([total], [late, lastMonth], all)).toEqual({
      raise: [total],
      clear: [late, lastMonth],
    });
  });

  it("never clears the monthly band alert, and leaves a rule alone when its inputs were unreadable", () => {
    expect(alertTransitions([], [band], all)).toEqual({ raise: [], clear: [] });
    expect(alertTransitions([], [late, total], new Set(["band_below"] as const))).toEqual({
      raise: [],
      clear: [],
    });
  });
});
