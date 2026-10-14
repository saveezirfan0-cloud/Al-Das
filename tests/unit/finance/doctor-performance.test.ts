import { describe, expect, it } from "vitest";

import {
  allowedBranchCodes,
  bandOf,
  buildDoctorPerformance,
  chosenBranch,
  coverageOf,
  DEFAULT_PERF_SETTINGS,
  measures,
  monthEnd,
  monthParam,
  parseDoctorPerformanceInputs,
  perfSettingsSchema,
  rangeLabel,
  type Counts,
  type DoctorPerformanceInputs,
} from "@/lib/finance/doctor-performance";

import fixture from "./fixtures/phase23-doctor-performance.synthetic.json";
import { referenceInputs, type FixtureRow } from "./doctor-performance-reference";

const inputs = () => parseDoctorPerformanceInputs(fixture.expected);
const C = (
  revenue: number,
  visits: number,
  patients: number,
  unbilledPatients = 0,
  newVisits = 0,
): Counts => ({
  revenue,
  visits,
  patients,
  unbilledPatients,
  newVisits,
});
const ZERO = C(0, 0, 0);

describe("fixture", () => {
  it("expected aggregates match an independent reference over the synthetic rows", () => {
    const ref = referenceInputs(fixture.rows as FixtureRow[], fixture.month);
    expect(ref.current).toEqual(fixture.expected.current);
    expect(ref.previous).toEqual(fixture.expected.previous);
  });
});

describe("bandOf", () => {
  it("uses half-open bands with no gaps (default 750 / 700 / 650)", () => {
    const s = DEFAULT_PERF_SETTINGS;
    expect(bandOf(649.99, s)).toBe("below");
    expect(bandOf(650, s)).toBe("moderate");
    expect(bandOf(699.99, s)).toBe("moderate");
    expect(bandOf(700, s)).toBe("near");
    expect(bandOf(749.99, s)).toBe("near");
    expect(bandOf(750, s)).toBe("achieved");
    expect(bandOf(0, s)).toBe("below");
    expect(bandOf(-5, s)).toBe("below");
    expect(bandOf(null, s)).toBeNull();
    expect(bandOf(Number.NaN, s)).toBeNull();
  });

  it("reads custom thresholds", () => {
    const s = { target: 1000, near: 900, moderate: 500 };
    expect(bandOf(499.99, s)).toBe("below");
    expect(bandOf(500, s)).toBe("moderate");
    expect(bandOf(899.99, s)).toBe("moderate");
    expect(bandOf(900, s)).toBe("near");
    expect(bandOf(999.99, s)).toBe("near");
    expect(bandOf(1000, s)).toBe("achieved");
    expect(bandOf(750, s)).toBe("moderate");
  });
});

describe("measures", () => {
  const s = DEFAULT_PERF_SETTINGS;

  it("works out per-patient revenue, expected revenue, gap, achievement and follow-ups", () => {
    const m = measures(C(2849.995, 6, 4, 1, 2), C(500, 2, 2), s);
    expect(m.revenuePerPatient).toBeCloseTo(712.49875, 9);
    expect(m.band).toBe("near");
    expect(m.expectedRevenue).toBe(3000);
    expect(m.gap).toBe(-150.005);
    expect(m.achievement).toBeCloseTo(0.94999833, 6);
    expect(m.followUps).toBe(2);
    expect(m.followUpsPerPatient).toBe(0.5);
    expect(m.unbilledShare).toBe(0.25);
    expect(m.change).toBe(2349.995);
    expect(m.changePct).toBeCloseTo(4.69999, 5);
    expect(m.patientsChangePct).toBe(1);
  });

  it("divides change by the PREVIOUS month, and gives null when it had no revenue", () => {
    expect(measures(C(431525, 10, 10), C(14859, 5, 5), s).changePct).toBeCloseTo(28.0412, 3);
    expect(measures(C(100, 1, 1), C(0, 1, 1), s).changePct).toBeNull();
    expect(measures(C(100, 1, 1), ZERO, s).patientsChangePct).toBeNull();
    expect(measures(ZERO, C(200, 1, 1), s).changePct).toBe(-1);
  });

  it("has no per-patient figures without patients", () => {
    const m = measures(ZERO, ZERO, s);
    expect(m).toMatchObject({
      revenuePerPatient: null,
      band: null,
      expectedRevenue: 0,
      gap: 0,
      achievement: null,
      followUps: 0,
      followUpsPerPatient: null,
      unbilledShare: null,
      change: 0,
      changePct: null,
    });
  });

  it("never gives negative follow-ups", () => {
    expect(measures(C(10, 2, 3), ZERO, s).followUps).toBe(0);
  });

  it("judges the band on the figure shown (to the fils), so badge and number always agree", () => {
    expect(measures(C(6500, 15, 10), ZERO, s)).toMatchObject({
      revenuePerPatient: 650,
      band: "moderate",
    });
    // 649.9985 shows as 650.00, so it is Moderate; 649.994 shows as 649.99, so it is Below Target
    expect(measures(C(6499.985, 15, 10), ZERO, s).band).toBe("moderate");
    expect(measures(C(1949.997, 5, 3), ZERO, s).band).toBe("moderate");
    expect(measures(C(6499.94, 15, 10), ZERO, s).band).toBe("below");
    // binary float noise cannot move an edge: 2100.3 / 3 is 700.0999… in floating point
    expect(bandOf(2100.3 / 3, { target: 750, near: 700.1, moderate: 650 })).toBe("near");
  });
});

describe("buildDoctorPerformance", () => {
  it("groups doctors under departments, sorted by revenue, with a doctor in two departments under both", () => {
    const r = buildDoctorPerformance(inputs());
    expect(r.departments.map((d) => d.label)).toEqual([
      "General Medicine",
      "Dermatology",
      "Pediatrics",
      "Unassigned",
    ]);
    const gm = r.departments[0];
    expect(gm.doctorRows.map((d) => [d.name, d.revenue])).toEqual([
      ["Dr Demo-01", 1500],
      ["Dr Demo-02", 1349.995],
    ]);
    expect(r.departments[1].doctorRows.map((d) => d.name)).toEqual(["Dr Demo-01", "Dr Demo-03"]);
    // Dr Demo-05 worked only last month: shown with zeros now, sorted after the doctors with revenue
    const peds = r.departments[2];
    expect(peds.doctorRows.map((d) => [d.name, d.revenue, d.previous.revenue])).toEqual([
      ["DR DEMO-04", 1149.99, 300],
      ["Dr Demo-05", 0, 700],
    ]);
    expect(peds.doctorRows[1]).toMatchObject({
      band: null,
      revenuePerPatient: null,
      changePct: -1,
    });
    expect(r.departments[3]).toMatchObject({ department: null, label: "Unassigned", revenue: 250 });
  });

  it("uses the department's and the clinic's own distinct patients, never the sum of doctors", () => {
    const r = buildDoctorPerformance(inputs());
    const gm = r.departments[0];
    expect(gm.doctorRows.reduce((a, d) => a + d.patients, 0)).toBe(5);
    expect(gm.patients).toBe(4);
    expect(gm.unbilledPatients).toBe(0); // unbilled with one doctor, billed by the other
    expect(gm.doctorRows[1].unbilledPatients).toBe(1);
    expect(r.total.patients).toBe(10);
    expect(r.departments.reduce((a, d) => a + d.patients, 0)).toBe(11);
    expect(r.total).toMatchObject({
      revenue: 6499.985,
      visits: 15,
      followUps: 5,
      band: "moderate",
      expectedRevenue: 7500,
      gap: -1000.015,
      change: 3499.985,
      doctors: 4,
      cancelledVisits: 1,
    });
    expect(r.total.revenuePerPatient).toBeCloseTo(649.9985, 9);
    expect(r.total.changePct).toBeCloseTo(1.16666, 4);
  });

  it("gives each department its doctor count, share and band; previous-only change works", () => {
    const r = buildDoctorPerformance(inputs());
    const derm = r.departments[1];
    expect(derm).toMatchObject({
      doctors: 2,
      previousDoctors: 1,
      revenuePerPatient: 750,
      band: "achieved",
    });
    expect(derm.share).toBeCloseTo(2250 / 6499.985, 8);
    const d2 = r.departments[0].doctorRows[1];
    expect(d2.previous.revenue).toBe(0);
    expect(d2.changePct).toBeNull();
    expect(d2.change).toBe(1349.995);
  });

  it("reconciles the departments to the total and reads the coverage", () => {
    const r = buildDoctorPerformance(inputs());
    expect(r.reconciliation).toEqual({ departmentsSum: 6499.985, total: 6499.985, matches: true });
    expect(r.coverage).toEqual({
      ranges: [{ from: "2026-09-01", to: "2026-09-30" }],
      full: true,
      label: "1–30 Sep 2026",
    });
    expect(r.hasData).toBe(true);
    const broken: DoctorPerformanceInputs = { ...inputs() };
    broken.current = { ...broken.current, total: { ...broken.current.total, revenue: 6499.986 } };
    expect(buildDoctorPerformance(broken).reconciliation.matches).toBe(false);
  });

  it("is empty for a month without data", () => {
    const r = buildDoctorPerformance(
      parseDoctorPerformanceInputs({
        month: "2025-01-01",
        previous_month: "2024-12-01",
        coverage: [],
      }),
    );
    expect(r.departments).toEqual([]);
    expect(r.hasData).toBe(false);
    expect(r.total.revenuePerPatient).toBeNull();
    expect(r.reconciliation.matches).toBe(true);
    expect(r.coverage).toMatchObject({
      full: false,
      label: "No committed upload covers this month",
    });
    expect(r.settings).toEqual(DEFAULT_PERF_SETTINGS);
  });
});

describe("coverage and parameters", () => {
  it("labels covered dates and flags a partly covered month", () => {
    expect(monthEnd("2026-02-01")).toBe("2026-02-28");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(rangeLabel({ from: "2026-09-01", to: "2026-09-30" })).toBe("1–30 Sep 2026");
    expect(rangeLabel({ from: "2026-10-01", to: "2026-10-01" })).toBe("1 Oct 2026");
    expect(rangeLabel({ from: "2026-08-28", to: "2026-09-03" })).toBe("28 Aug – 3 Sep 2026");
    const part = coverageOf("2026-09-01", [
      { from: "2026-09-01", to: "2026-09-15" },
      { from: "2026-09-20", to: "2026-09-30" },
    ]);
    expect(part).toMatchObject({ full: false, label: "1–15 Sep 2026, 20–30 Sep 2026" });
  });

  it("reads the month and branch parameters safely", () => {
    expect(monthParam("2026-09")).toBe("2026-09-01");
    expect(monthParam("2026-09-17")).toBe("2026-09-01");
    for (const bad of ["", "2026-13", "26-09", "2026-9", "x", null, undefined])
      expect(monthParam(bad)).toBeNull();
    expect(chosenBranch("gm", null)).toBe("GM");
    expect(chosenBranch("GM", ["PJ"])).toBeNull();
    expect(chosenBranch("PJ'; drop", ["PJDR"])).toBe("PJDR");
    expect(chosenBranch("", ["PJ"])).toBeNull();
  });

  it("maps a member's branches to finance codes (null = everything)", () => {
    const locations = [
      { id: "l1", branch_code: "PJ" },
      { id: "l2", branch_code: "GM" },
      { id: "l3", branch_code: null },
    ];
    expect(allowedBranchCodes(null, locations)).toBeNull();
    expect(allowedBranchCodes(["l2"], locations)).toEqual(["GM"]);
    expect(allowedBranchCodes(["l2", "l1"], locations)).toEqual(["GM", "PJ"]);
    expect(allowedBranchCodes(["l3"], locations)).toEqual([]); // only rows with no branch
    expect(allowedBranchCodes([], locations)).toEqual([]);
  });
});

describe("settings validation", () => {
  const ok = { perf_arpp_target: "750", perf_band_near: "700", perf_band_moderate: "650" };
  it("accepts ordered thresholds", () => {
    expect(perfSettingsSchema.safeParse(ok)).toMatchObject({
      success: true,
      data: { perf_arpp_target: 750, perf_band_near: 700, perf_band_moderate: 650 },
    });
    expect(perfSettingsSchema.safeParse({ ...ok, perf_band_moderate: "650.50" }).success).toBe(
      true,
    );
  });
  it("refuses bands out of order, zero, negatives, too many decimals and text", () => {
    for (const bad of [
      { ...ok, perf_band_near: "750" },
      { ...ok, perf_band_moderate: "700" },
      { ...ok, perf_arpp_target: "600" },
      { ...ok, perf_band_moderate: "0" },
      { ...ok, perf_band_moderate: "-1" },
      { ...ok, perf_band_near: "700.123" },
      { ...ok, perf_arpp_target: "lots" },
      { ...ok, perf_arpp_target: "2000000" },
    ])
      expect(perfSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
