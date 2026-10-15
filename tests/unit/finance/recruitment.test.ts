import { describe, expect, it } from "vitest";

import {
  computeRecruitment,
  defaultInputs,
  eventsInWindow,
  monthStart,
  parseBenchmarks,
  pickBenchmark,
  recruitBand,
  recruitmentInputsSchema,
  recruitSettingsSchema,
  type Benchmarks,
  type CalendarEvent,
  type RecruitmentInputs,
} from "@/lib/finance/recruitment";

/**
 * Recruitment viability calculator (M4). Every expected figure below was worked out by hand (shown in the comments).
 * Synthetic numbers only; no real candidate.
 */

const SETTINGS = { conservativePct: 70, consumablesPct: 12, gatewayPct: 1.5, minPeerMonths: 6 };

/** Claimed 100,000 × 70 % = 70,000, + equipment 10,000 + nurse 5,000 = revenue 85,000. */
const base = (over: Partial<RecruitmentInputs> = {}): RecruitmentInputs => ({
  ...defaultInputs(SETTINGS),
  claimedRevenue: 100_000,
  equipmentRevenue: 10_000,
  staffRevenue: 5_000,
  // 6,000 / 12 = 500, 7,200 / 24 = 300, 10,000 and 8,000 monthly: indirect 18,800 (doctor's own: 800)
  indirect: {
    dha_licence: { amount: 6_000, months: 12 },
    visa: { amount: 7_200, months: 24 },
    room_rent: { amount: 10_000, months: 1 },
    nurse: { amount: 8_000, months: 1 },
  },
  ...over,
});

/** Revenue entered directly (equipment line only), for checking profit at a given revenue. */
const atRevenue = (i: RecruitmentInputs, r: number) =>
  computeRecruitment({ ...i, claimedRevenue: 0, equipmentRevenue: r, staffRevenue: 0 });

describe("recruitment engine: the chain", () => {
  it("fixed salary: salary is a fixed cost; breakeven = (salary + indirect) ÷ (1 − variable %)", () => {
    const r = computeRecruitment(
      base({ contractType: "fixed_salary", salary: 30_000, setupCost: 50_000 }),
    );
    expect(r.revenue).toEqual({
      claimed: 100_000,
      conservativeClaimed: 70_000,
      equipment: 10_000,
      staff: 5_000,
      total: 85_000,
    });
    expect(r.consumables).toBe(10_200); // 12 % of 85,000
    expect(r.gateway).toBe(1_275); // 1.5 %
    expect(r.grossMargin).toBe(73_525);
    expect(r.shareAmount).toBeNull();
    expect(r.doctorPay).toBe(30_000);
    expect(r.payBasis).toBe("salary");
    expect(r.netMargin).toBe(43_525);
    expect(r.indirectMonthly).toBe(18_800);
    expect(r.profitMonthly).toBe(24_725);
    expect(r.profitAnnual).toBe(296_700);
    expect(r.costToCompany).toBe(30_800); // pay + licence 500 + visa 300 (room and nurse are not the doctor's cost)
    expect(r.ctcPctOfRevenue).toBeCloseTo(30_800 / 85_000, 12);
    expect(r.revenuePerAedPaid).toBeCloseTo(85_000 / 30_000, 12);
    expect(r.viability).toBe("viable");
    // fixed 30,000 + 18,800 = 48,800; ratio 1 − 0.135 = 0.865; 48,800 / 0.865 = 56,416.184971...
    expect(r.breakeven.fixedCosts).toBe(48_800);
    expect(r.breakeven.contributionRatio).toBe(0.865);
    expect(r.breakeven.revenue).toBeCloseTo(56_416.184971, 5);
    expect(r.breakeven.pctOfRevenue).toBeCloseTo(56_416.184971 / 85_000, 9);
    expect(r.breakeven.safetyMargin).toBeCloseTo(1 - 56_416.184971 / 85_000, 9);
    expect(r.monthsToRecover).toBe(3); // 50,000 / 24,725 = 2.02 → 3 whole months
  });

  it("does NOT treat a fixed salary as variable (May-model defect 2)", () => {
    // the old formula: indirect ÷ net margin % = 18,800 / (43,525 / 85,000) = 36,714.53 — wrong
    const r = computeRecruitment(base({ contractType: "fixed_salary", salary: 30_000 }));
    expect(r.breakeven.revenue).not.toBeCloseTo(36_714.53, 0);
    expect(
      atRevenue(base({ contractType: "fixed_salary", salary: 30_000 }), r.breakeven.revenue!)
        .profitMonthly,
    ).toBeCloseTo(0, 6);
  });

  it("salary-backed: pay is max(S, V), never S + V; the share is on revenue after consumables and gateway", () => {
    const r = computeRecruitment(
      base({ contractType: "salary_backed_share", salary: 20_000, sharePct: 40 }),
    );
    expect(r.shareAmount).toBe(29_410); // 40 % of 73,525
    expect(r.doctorPay).toBe(29_410);
    expect(r.payBasis).toBe("share");
    expect(r.netMargin).toBe(44_115);
    expect(r.profitMonthly).toBe(25_315);
    // k = 0.4 × 0.865 = 0.346; the share overtakes the salary at 20,000 / 0.346 = 57,803.47.
    // Below it: (20,000 + 18,800) / 0.865 = 44,855.49 ≤ 57,803.47, so breakeven is on the salary stretch.
    expect(r.breakeven.revenue).toBeCloseTo(44_855.491329, 5);
    expect(r.breakeven.contributionRatio).toBe(0.865);
    expect(r.breakeven.fixedCosts).toBe(38_800);

    const low = computeRecruitment(
      base({ contractType: "salary_backed_share", salary: 40_000, sharePct: 40 }),
    );
    expect(low.doctorPay).toBe(40_000); // salary is higher than the 29,410 share
    expect(low.payBasis).toBe("salary");
    expect(low.shareAmount).toBe(29_410);
  });

  it("salary-backed: breakeven on the share stretch is solved piecewise", () => {
    // S 20,000, indirect 40,000: salary stretch needs 60,000 / 0.865 = 69,364.16 > 57,803.47 (switch), so the answer is
    // on the share stretch: 40,000 / (0.865 − 0.346) = 77,071.29
    const i = base({
      contractType: "salary_backed_share",
      salary: 20_000,
      sharePct: 40,
      indirect: { room_rent: { amount: 40_000, months: 1 } },
    });
    const r = computeRecruitment(i);
    expect(r.breakeven.revenue).toBeCloseTo(40_000 / 0.519, 5);
    expect(r.breakeven.contributionRatio).toBeCloseTo(0.519, 12);
    expect(r.breakeven.fixedCosts).toBe(40_000);
    const at = atRevenue(i, r.breakeven.revenue!);
    expect(at.payBasis).toBe("share");
    expect(at.profitMonthly).toBeCloseTo(0, 6);
  });

  it("share only and gross basis: V = share × revenue; breakeven = indirect ÷ (1 − variable − share)", () => {
    const r = computeRecruitment(
      base({ contractType: "share_only", sharePct: 30, shareBasis: "gross", salary: 99_999 }),
    );
    expect(r.doctorPay).toBe(25_500); // 30 % of 85,000; the typed salary is ignored
    expect(r.breakeven.revenue).toBeCloseTo(18_800 / 0.565, 6); // 33,274.336
    expect(r.breakeven.contributionRatio).toBe(0.565);
  });

  it("practitioner share: always on net revenue; breakeven = indirect ÷ ((1 − variable) × (1 − share))", () => {
    const r = computeRecruitment(
      base({ contractType: "practitioner_share", sharePct: 50, shareBasis: "gross" }),
    );
    expect(r.doctorPay).toBe(36_762.5); // 50 % of 73,525: the gross choice does not apply here
    expect(r.breakeven.revenue).toBeCloseTo(18_800 / 0.4325, 6); // 43,468.21
  });

  it("viability: marginal when the net margin covers pay but not the indirect costs", () => {
    const r = computeRecruitment(base({ contractType: "fixed_salary", salary: 60_000 }));
    expect(r.netMargin).toBe(13_525);
    expect(r.profitMonthly).toBe(-5_275);
    expect(r.viability).toBe("marginal");
    expect(r.monthsToRecover).toBe(0); // no setup cost
    expect(
      computeRecruitment(base({ contractType: "fixed_salary", salary: 60_000, setupCost: 1 }))
        .monthsToRecover,
    ).toBeNull();
    expect(
      computeRecruitment(base({ contractType: "fixed_salary", salary: 80_000 })).viability,
    ).toBe("not_viable");
  });
});

describe("recruitment engine: edge cases", () => {
  it("zero revenue: not viable, no ratios, breakeven still shown", () => {
    const r = computeRecruitment(
      base({
        contractType: "fixed_salary",
        salary: 30_000,
        claimedRevenue: 0,
        equipmentRevenue: 0,
        staffRevenue: 0,
      }),
    );
    expect(r.revenue.total).toBe(0);
    expect(r.profitMonthly).toBe(-48_800);
    expect(r.viability).toBe("not_viable");
    expect(r.grossMarginPct).toBeNull();
    expect(r.ctcPctOfRevenue).toBeNull();
    expect(r.breakeven.revenue).toBeCloseTo(56_416.184971, 5);
    expect(r.breakeven.pctOfRevenue).toBeNull();
    expect(r.breakeven.safetyMargin).toBeNull();
  });

  it("share 0 %: nothing is paid; revenue per AED paid is blank", () => {
    const r = computeRecruitment(base({ contractType: "share_only", sharePct: 0 }));
    expect(r.doctorPay).toBe(0);
    expect(r.revenuePerAedPaid).toBeNull();
    expect(r.breakeven.revenue).toBeCloseTo(18_800 / 0.865, 6);
    // salary-backed with a 0 % share is just the salary
    const s = computeRecruitment(
      base({ contractType: "salary_backed_share", salary: 30_000, sharePct: 0 }),
    );
    expect(s.doctorPay).toBe(30_000);
    expect(s.breakeven.revenue).toBeCloseTo(48_800 / 0.865, 6);
  });

  it("no fixed costs but variable costs above 100 %: never, not 0", () => {
    const r = computeRecruitment(
      base({
        contractType: "share_only",
        sharePct: 0,
        consumablesPct: 99,
        gatewayPct: 2,
        indirect: {},
      }),
    );
    expect(r.breakeven.revenue).toBeNull();
    expect(r.profitMonthly).toBeLessThan(0);
  });

  it("margin ≤ 0: breakeven is never", () => {
    // consumables + gateway take everything
    const all = computeRecruitment(
      base({ contractType: "fixed_salary", salary: 1, consumablesPct: 98.5, gatewayPct: 1.5 }),
    );
    expect(all.breakeven.revenue).toBeNull();
    expect(all.breakeven.pctOfRevenue).toBeNull();
    expect(all.breakeven.safetyMargin).toBeNull();
    // a gross share larger than what is left after variable costs
    const big = computeRecruitment(
      base({ contractType: "share_only", sharePct: 90, shareBasis: "gross" }),
    );
    expect(big.breakeven.revenue).toBeNull();
    expect(big.breakeven.contributionRatio).toBeCloseTo(-0.035, 12);
    // salary-backed where the share stretch loses money and the salary stretch cannot reach 0 before the switch
    const sb = computeRecruitment(
      base({
        contractType: "salary_backed_share",
        salary: 20_000,
        sharePct: 95,
        shareBasis: "gross",
      }),
    );
    expect(sb.breakeven.revenue).toBeNull();
  });

  it("nothing fixed: breakeven at 0", () => {
    const r = computeRecruitment(base({ contractType: "share_only", sharePct: 40, indirect: {} }));
    expect(r.breakeven.revenue).toBe(0);
    expect(r.breakeven.safetyMargin).toBe(1);
  });

  it("profit is exactly 0 at breakeven and negative just below it, for every pay model (brute force)", () => {
    const cases: Partial<RecruitmentInputs>[] = [];
    for (const salary of [0, 15_000, 45_000])
      for (const sharePct of [0, 25, 60])
        for (const shareBasis of ["net", "gross"] as const)
          for (const contractType of [
            "fixed_salary",
            "salary_backed_share",
            "share_only",
            "practitioner_share",
          ] as const)
            cases.push({ salary, sharePct, shareBasis, contractType });
    let solved = 0;
    for (const c of cases) {
      const i = base(c);
      const r = computeRecruitment(i);
      if (r.breakeven.revenue === null) {
        // never: profit stays ≤ 0 over a wide range
        for (const x of [0, 1e4, 1e5, 1e6, 1e7])
          expect(atRevenue(i, x).profitMonthly, JSON.stringify(c)).toBeLessThanOrEqual(1e-6);
        continue;
      }
      solved++;
      expect(atRevenue(i, r.breakeven.revenue).profitMonthly, JSON.stringify(c)).toBeCloseTo(0, 4);
      if (r.breakeven.revenue > 1)
        expect(atRevenue(i, r.breakeven.revenue - 1).profitMonthly).toBeLessThan(0);
      expect(atRevenue(i, r.breakeven.revenue + 1).profitMonthly).toBeGreaterThan(0);
    }
    expect(solved).toBeGreaterThan(40);
  });
});

describe("recruitment inputs", () => {
  it("drops what the contract type does not use and keeps only indirect lines above 0", () => {
    const v = recruitmentInputsSchema.parse({
      contractType: "share_only",
      salary: "20000",
      sharePct: "35",
      shareBasis: "gross",
      claimedRevenue: "50000",
      conservativePct: 70,
      consumablesPct: 12,
      gatewayPct: 1.5,
      indirect: { visa: { amount: "0", months: "24" }, nurse: { amount: "9000", months: "1" } },
      startMonth: "2027-01",
      department: "  ",
    });
    expect(v.salary).toBe(0);
    expect(v.sharePct).toBe(35);
    expect(v.shareBasis).toBe("gross");
    expect(v.indirect).toEqual({ nurse: { amount: 9000, months: 1 } });
    expect(v.startMonth).toBe("2027-01-01");
    expect(v.department).toBeNull();

    const f = recruitmentInputsSchema.parse({ ...v, contractType: "fixed_salary", salary: 25_000 });
    expect(f.sharePct).toBe(0);
    expect(f.shareBasis).toBe("net");
    const p = recruitmentInputsSchema.parse({ ...v, contractType: "practitioner_share" });
    expect(p.shareBasis).toBe("net");
  });

  it("refuses negatives, percentages above 100, unknown cost lines and bad months", () => {
    const ok = {
      contractType: "fixed_salary",
      conservativePct: 70,
      consumablesPct: 12,
      gatewayPct: 1.5,
    };
    expect(recruitmentInputsSchema.safeParse(ok).success).toBe(true);
    expect(recruitmentInputsSchema.safeParse({ ...ok, salary: -1 }).success).toBe(false);
    expect(recruitmentInputsSchema.safeParse({ ...ok, consumablesPct: 101 }).success).toBe(false);
    expect(recruitmentInputsSchema.safeParse({ ...ok, contractType: "gp_incentive" }).success).toBe(
      false,
    );
    expect(
      recruitmentInputsSchema.safeParse({ ...ok, indirect: { bonus: { amount: 1, months: 1 } } })
        .success,
    ).toBe(false);
    expect(
      recruitmentInputsSchema.safeParse({ ...ok, indirect: { visa: { amount: 1, months: 0 } } })
        .success,
    ).toBe(false);
    expect(recruitmentInputsSchema.safeParse({ ...ok, startMonth: "2027-13" }).success).toBe(false);
    expect(monthStart("2026-02-15")).toBe("2026-02-01");
    expect(monthStart("26-02")).toBeNull();
  });

  it("defaults come from the clinic's settings", () => {
    const d = defaultInputs({
      conservativePct: 65,
      consumablesPct: 10,
      gatewayPct: 2,
      minPeerMonths: 3,
    });
    expect([d.conservativePct, d.consumablesPct, d.gatewayPct]).toEqual([65, 10, 2]);
  });

  it("settings form: ranges and consumables + gateway below 100 %", () => {
    const ok = {
      recruit_conservative_pct: "70",
      recruit_consumables_pct: "12",
      recruit_gateway_pct: "1.5",
      recruit_min_peer_months: "6",
    };
    expect(recruitSettingsSchema.parse(ok)).toEqual({
      recruit_conservative_pct: 70,
      recruit_consumables_pct: 12,
      recruit_gateway_pct: 1.5,
      recruit_min_peer_months: 6,
    });
    expect(recruitSettingsSchema.safeParse({ ...ok, recruit_conservative_pct: "0" }).success).toBe(
      false,
    );
    expect(recruitSettingsSchema.safeParse({ ...ok, recruit_min_peer_months: "2.5" }).success).toBe(
      false,
    );
    expect(
      recruitSettingsSchema.safeParse({ ...ok, recruit_consumables_pct: "98.5" }).success,
    ).toBe(false);
  });
});

describe("benchmarks and bands", () => {
  const b = (over: Partial<Benchmarks> = {}): Benchmarks => ({
    settings: SETTINGS,
    months: ["2026-08-01", "2026-09-01"],
    departments: [
      { department: "Dermatology", doctorMonths: 8, doctors: 4, median: 60_000, p75: 80_000 },
      { department: "Dental", doctorMonths: 9, doctors: 1, median: 90_000, p75: 95_000 },
      { department: "Physiotherapy", doctorMonths: 4, doctors: 2, median: 30_000, p75: 35_000 },
    ],
    clinic: { department: null, doctorMonths: 21, doctors: 7, median: 55_000, p75: 85_000 },
    ...over,
  });

  it("uses the department when it has enough doctor-months from more than one doctor", () => {
    const c = pickBenchmark(b(), "Dermatology");
    expect(c.source).toBe("department");
    expect(c.reason).toBeNull();
    expect(recruitBand(80_000, c.row)).toBe("A"); // ≥ p75
    expect(recruitBand(79_999.99, c.row)).toBe("B");
    expect(recruitBand(60_000, c.row)).toBe("B"); // ≥ median
    expect(recruitBand(59_999.99, c.row)).toBe("below");
  });

  it("falls back to the clinic, and says why, for one-doctor or thin departments (May-model defect 3)", () => {
    const one = pickBenchmark(b(), "Dental");
    expect(one.source).toBe("clinic");
    expect(one.reason).toMatch(/only one doctor/);
    const thin = pickBenchmark(b(), "Physiotherapy");
    expect(thin.source).toBe("clinic");
    expect(thin.reason).toMatch(/4 doctor-months, fewer than the 6/);
    expect(pickBenchmark(b(), "Cardiology").reason).toMatch(/No report data for Cardiology/);
    expect(pickBenchmark(b(), null).reason).toMatch(/No department chosen/);
  });

  it("gives no band when the clinic itself has too little data (fail closed)", () => {
    const c = pickBenchmark(
      b({
        departments: [],
        clinic: { department: null, doctorMonths: 5, doctors: 3, median: 1, p75: 2 },
      }),
      "Dermatology",
    );
    expect(c.source).toBe("none");
    expect(c.row).toBeNull();
    expect(recruitBand(100_000, c.row)).toBeNull();
  });

  it("the threshold is the clinic's setting", () => {
    expect(
      pickBenchmark(b({ settings: { ...SETTINGS, minPeerMonths: 4 } }), "Physiotherapy").source,
    ).toBe("department");
    expect(
      pickBenchmark(b({ settings: { ...SETTINGS, minPeerMonths: 9 } }), "Dermatology").source,
    ).toBe("clinic");
  });

  it("parses the SQL output, numbers as strings included", () => {
    const p = parseBenchmarks({
      settings: {
        conservative_pct: "70.00",
        consumables_pct: 12,
        gateway_pct: "1.50",
        min_peer_months: 6,
      },
      months: ["2026-09-01"],
      departments: [
        { department: "Dermatology", doctor_months: 6, doctors: 2, median: "1000.500", p75: 1200 },
      ],
      clinic: { department: null, doctor_months: 6, doctors: 2, median: null, p75: null },
    });
    expect(p.settings).toEqual(SETTINGS);
    expect(p.departments[0]).toEqual({
      department: "Dermatology",
      doctorMonths: 6,
      doctors: 2,
      median: 1000.5,
      p75: 1200,
    });
    expect(p.clinic.median).toBeNull();
    expect(parseBenchmarks(null).departments).toEqual([]);
  });
});

describe("seasonal note", () => {
  const ev = (
    id: string,
    startsOn: string,
    endsOn: string,
    kind: CalendarEvent["kind"] = "eid",
  ): CalendarEvent => ({
    id,
    startsOn,
    endsOn,
    kind,
    label: id,
    approximate: true,
  });
  const events = [
    ev("ramadan-1448", "2027-02-08", "2027-03-09", "ramadan"),
    ev("eid-1448", "2027-03-10", "2027-03-12"),
    ev("adha-1447", "2026-05-26", "2026-05-29"),
    ev("long", "2026-06-01", "2026-12-31", "other"),
  ];

  it("lists the events overlapping the first three months, across a year end", () => {
    const w = eventsInWindow(events, "2026-12-01")!;
    expect(w.from).toBe("2026-12-01");
    expect(w.to).toBe("2027-02-28");
    expect(w.events.map((e) => e.id)).toEqual(["long", "ramadan-1448"]);
  });

  it("counts an event that starts on the last day or ends on the first day", () => {
    expect(
      eventsInWindow([ev("x", "2027-03-31", "2027-04-02")], "2027-01-01")!.events,
    ).toHaveLength(1);
    expect(
      eventsInWindow([ev("y", "2026-12-20", "2027-01-01")], "2027-01-01")!.events,
    ).toHaveLength(1);
    expect(
      eventsInWindow([ev("z", "2026-12-20", "2026-12-31")], "2027-01-01")!.events,
    ).toHaveLength(0);
  });

  it("gives no note without a start month", () => {
    expect(eventsInWindow(events, null)).toBeNull();
  });
});
