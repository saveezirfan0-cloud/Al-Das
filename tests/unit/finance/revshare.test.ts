/**
 * Slice 20F: the revenue-share calculator and rule vocabulary (pure). A synthetic month (revshare.synthetic.json, worked
 * out by hand) checks every step; the edge cases below check the threshold pro rata, category overrides, deductions, the
 * minimum guarantee, never negative, rounding to 2 decimals half away from zero, and that the rule refuses anything
 * outside its closed vocabulary. Synthetic ids and amounts only.
 */
import { describe, expect, it } from "vitest";

import {
  buildRunSnapshot,
  calculatePayout,
  CALC_VERSION,
  cleanRule,
  DEFAULT_RULE,
  parseChargesCsv,
  parseRule,
  percentToRate,
  readSnapshot,
  ruleFromForm,
  ruleSummary,
  runTrailCsv,
  type RevshareRule,
} from "@/lib/finance/revshare";

import { FIXTURE, inputsFromFixture } from "./revshare-fixture";

const rule = (r: Partial<RevshareRule>): RevshareRule => ({
  basis: "net_revenue",
  default_rate: 0,
  deductions: {},
  ...r,
});

describe("the synthetic month", () => {
  const snap = buildRunSnapshot(inputsFromFixture());

  it("gives every doctor with an approved scheme exactly the hand-worked figures", () => {
    expect(snap.results.map((r) => r.doctor_dha_id)).toEqual(
      FIXTURE.expected.results.map((e) => e.doctor),
    );
    for (const e of FIXTURE.expected.results) {
      const r = snap.results.find((x) => x.doctor_dha_id === e.doctor)!;
      const { doctor, ...want } = e;
      expect({ ...r.calc, minimum_guarantee: undefined, threshold: undefined }, doctor).toEqual({
        ...want,
        minimum_guarantee: undefined,
        threshold: undefined,
      });
      expect(r.payout, doctor).toBe(e.payout);
    }
  });

  it("lists doctors without a scheme, revenue without a doctor, and totals that tie to the lines", () => {
    expect(snap.no_scheme).toEqual(FIXTURE.expected.no_scheme);
    expect(snap.unassigned_revenue).toBe(FIXTURE.expected.unassigned_revenue);
    expect(snap.totals).toEqual(FIXTURE.expected.totals);
    const cents = snap.results.reduce((s, r) => s + Math.round(r.payout * 100), 0);
    expect(cents / 100).toBe(snap.totals.payout);
  });

  it("keeps the inputs exactly as received, names the doctors and records the scheme used", () => {
    const raw = inputsFromFixture();
    const s = buildRunSnapshot(raw);
    expect(s.inputs).toBe(raw);
    expect(s.calc_version).toBe(CALC_VERSION);
    expect(s.month).toBe("2026-09-01");
    const one = s.results.find((r) => r.doctor_dha_id === "SYN-0001")!;
    expect(one.doctor_name).toBe("Dr Synthetic One");
    expect(one.scheme_version).toBe(1);
    expect(one.rule).toEqual(FIXTURE.schemes[0].rule);
    expect(readSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(JSON.parse(JSON.stringify(s)));
    expect(readSnapshot({ calc_version: "other" })).toBeNull();
  });

  it("refuses inputs whose approved rule is not a valid rule", () => {
    const raw = inputsFromFixture();
    (raw.schemes[0] as { rule: unknown }).rule = {
      basis: "net_revenue",
      default_rate: 2,
      deductions: {},
    };
    expect(() => buildRunSnapshot(raw)).toThrow(/invalid rule/);
    expect(() => buildRunSnapshot({ month: "x" })).toThrow();
  });
});

describe("calculatePayout", () => {
  it("applies the default rate to every category without its own rate", () => {
    const c = calculatePayout(
      rule({ default_rate: 0.35 }),
      [
        { category: "Consultation", net: 1000 },
        { category: "Lab", net: 500 },
      ],
      [],
    );
    expect(c.categories.map((k) => [k.category, k.rate, k.rate_source, k.earned])).toEqual([
      ["Consultation", 0.35, "default", 350],
      ["Lab", 0.35, "default", 175],
    ]);
    expect(c.payout).toBe(525);
  });

  it("uses a category's own rate, including 0 %, and matches category names exactly", () => {
    const c = calculatePayout(
      rule({ default_rate: 0.3, category_rates: { Lab: 0, Radiology: 0.1 } }),
      [
        { category: "Lab", net: 1000 },
        { category: "lab", net: 1000 },
        { category: "Radiology", net: 2000 },
      ],
      [],
    );
    expect(c.categories.map((k) => [k.category, k.rate_source, k.earned])).toEqual([
      ["Lab", "category", 0],
      ["Radiology", "category", 200],
      ["lab", "default", 300],
    ]);
    expect(c.share).toBe(500);
  });

  it("adds up several rows of the same category", () => {
    const c = calculatePayout(
      rule({ default_rate: 0.5 }),
      [
        { category: "Lab", net: 100.1 },
        { category: "Lab", net: 0.2 },
      ],
      [],
    );
    expect(c.categories).toHaveLength(1);
    expect(c.base).toBe(100.3);
    expect(c.share).toBe(50.15);
  });

  describe("threshold (monthly, pro rata over the categories)", () => {
    const revenue = [
      { category: "Consultation", net: 6000 },
      { category: "Lab", net: 4000 },
    ];
    it("earns only on revenue above the threshold, spread pro rata", () => {
      const c = calculatePayout(rule({ default_rate: 0.5, threshold: 4000 }), revenue, []);
      expect(c.eligible_fraction).toBe(0.6);
      expect(c.categories.map((k) => [k.gross, k.earned])).toEqual([
        [3000, 1800],
        [2000, 1200],
      ]);
      expect(c.share).toBe(3000); // (10,000 - 4,000) x 50 %
    });
    it("earns nothing at or below the threshold", () => {
      for (const t of [10000, 12000]) {
        const c = calculatePayout(rule({ default_rate: 0.5, threshold: t }), revenue, []);
        expect(c.eligible_fraction).toBe(0);
        expect(c.share).toBe(0);
      }
    });
    it("one cent above the threshold earns on one cent", () => {
      const c = calculatePayout(rule({ default_rate: 1, threshold: 9999.99 }), revenue, []);
      expect(c.share).toBe(0.01);
    });
    it("a threshold of 0 changes nothing, and no threshold means everything counts", () => {
      expect(calculatePayout(rule({ default_rate: 0.5, threshold: 0 }), revenue, []).share).toBe(
        5000,
      );
      const none = calculatePayout(rule({ default_rate: 0.5 }), revenue, []);
      expect(none.threshold).toBeNull();
      expect(none.eligible_fraction).toBe(1);
      expect(none.share).toBe(5000);
    });
    it("a base of zero or below never earns when a threshold is set", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.5, threshold: 0 }),
        [{ category: "Lab", net: -100 }],
        [],
      );
      expect(c.eligible_fraction).toBe(0);
      expect(c.share).toBe(0);
    });
  });

  describe("deductions", () => {
    it("deducts each kind at its share and ignores kinds the rule does not name", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.5, deductions: { lab: 1, referral: 0.5 } }),
        [{ category: "Consultation", net: 10000 }],
        [
          { kind: "lab", amount: 300 },
          { kind: "lab", amount: 200 },
          { kind: "referral", amount: 1000 },
          { kind: "consumables", amount: 400 },
          { kind: "other", amount: 0 },
        ],
      );
      expect(c.deductions).toEqual([
        { kind: "lab", charges: 500, share: 1, deducted: 500 },
        { kind: "referral", charges: 1000, share: 0.5, deducted: 500 },
        { kind: "consumables", charges: 400, share: 0, deducted: 0 },
      ]);
      expect(c.total_deductions).toBe(1000);
      expect(c.before_guarantee).toBe(4000);
      expect(c.payout).toBe(4000);
    });
    it("the default rule charges lab and external referral costs in full", () => {
      expect(DEFAULT_RULE.deductions).toEqual({ lab: 1, referral: 1 });
      const c = calculatePayout(
        { ...DEFAULT_RULE, default_rate: 0.4 },
        [{ category: "X", net: 1000 }],
        [
          { kind: "lab", amount: 100 },
          { kind: "referral", amount: 50 },
        ],
      );
      expect(c.payout).toBe(250);
    });
  });

  describe("minimum guarantee and never negative", () => {
    it("pays the guarantee when the calculation is lower", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.1, minimum_guarantee: 5000 }),
        [{ category: "X", net: 10000 }],
        [],
      );
      expect([c.before_guarantee, c.payout, c.outcome]).toEqual([1000, 5000, "guarantee"]);
    });
    it("pays the calculation when it is higher or equal", () => {
      const hi = calculatePayout(
        rule({ default_rate: 0.6, minimum_guarantee: 5000 }),
        [{ category: "X", net: 10000 }],
        [],
      );
      expect([hi.payout, hi.outcome]).toEqual([6000, "calculated"]);
      const eq = calculatePayout(
        rule({ default_rate: 0.5, minimum_guarantee: 5000 }),
        [{ category: "X", net: 10000 }],
        [],
      );
      expect([eq.payout, eq.outcome]).toEqual([5000, "calculated"]);
    });
    it("never pays below zero, and a zero guarantee changes nothing", () => {
      for (const g of [undefined, 0]) {
        const c = calculatePayout(
          rule({ default_rate: 0.1, deductions: { lab: 1 }, minimum_guarantee: g }),
          [{ category: "X", net: 100 }],
          [{ kind: "lab", amount: 1000 }],
        );
        expect([c.before_guarantee, c.payout, c.outcome]).toEqual([-990, 0, "zero"]);
      }
    });
    it("pays the guarantee to a doctor with no revenue", () => {
      const c = calculatePayout(rule({ default_rate: 0.3, minimum_guarantee: 2500 }), [], []);
      expect([c.base, c.share, c.payout, c.outcome]).toEqual([0, 0, 2500, "guarantee"]);
    });
  });

  describe("rounding to 2 decimals, half away from zero, exactly", () => {
    it("rounds halves away from zero for revenue and credits", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.5 }),
        [
          { category: "A", net: 0.15 },
          { category: "B", net: -0.15 },
          { category: "C", net: 0.05 },
        ],
        [],
      );
      expect(c.categories.map((k) => k.earned)).toEqual([0.08, -0.08, 0.03]);
      expect(c.share).toBe(0.03);
    });
    it("the share is the sum of the rounded category amounts, so the steps shown always add up", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.3333, threshold: 1000 }),
        [
          { category: "A", net: 1234.57 },
          { category: "B", net: 765.43 },
          { category: "C", net: 333.33 },
        ],
        [],
      );
      const sum = c.categories.reduce((s, k) => s + Math.round(k.earned * 100), 0) / 100;
      expect(c.share).toBe(sum);
      for (const k of c.categories) expect(Math.round(k.earned * 100)).toBe(k.earned * 100);
    });
    it("handles large amounts without floating-point drift", () => {
      const c = calculatePayout(
        rule({ default_rate: 0.3333, threshold: 123456789.01 }),
        [{ category: "A", net: 999999999.99 }],
        [{ kind: "lab", amount: 0.01 }],
      );
      // (999,999,999.99 - 123,456,789.01) x 33.33 % = 292,151,852.219634 -> 292,151,852.22 (lab not deducted)
      expect(c.share).toBe(292151852.22);
      expect(c.payout).toBe(292151852.22);
    });
    it("deductions round half away from zero too", () => {
      const c = calculatePayout(
        rule({ deductions: { referral: 0.5 } }),
        [],
        [{ kind: "referral", amount: 0.05 }],
      );
      expect(c.total_deductions).toBe(0.03);
    });
  });
});

describe("the rule vocabulary (closed)", () => {
  const ok = rule({
    default_rate: 0.35,
    category_rates: { Lab: 0.1 },
    deductions: { lab: 1 },
    threshold: 1000.5,
    minimum_guarantee: 0,
  });

  it("accepts a valid rule and the default", () => {
    expect(parseRule(ok)).toEqual(ok);
    expect(parseRule(DEFAULT_RULE)).toEqual(DEFAULT_RULE);
  });

  it("refuses unknown keys anywhere, other bases and missing parts", () => {
    for (const bad of [
      { ...ok, formula: "rate * net" },
      { ...ok, basis: "collected" },
      { ...ok, deductions: { lab: 1, rent: 1 } },
      { basis: "net_revenue", default_rate: 0.3 },
      { basis: "net_revenue", deductions: {} },
      { ...ok, deductions: [] },
      { ...ok, category_rates: [] },
      [],
      null,
      "0.3",
    ])
      expect(parseRule(bad), JSON.stringify(bad)).toBeNull();
  });

  it("refuses rates outside 0 to 1 or with more than 4 decimals, and bad amounts", () => {
    for (const bad of [
      { ...ok, default_rate: 1.01 },
      { ...ok, default_rate: -0.1 },
      { ...ok, default_rate: 0.12345 },
      { ...ok, default_rate: "0.3" },
      { ...ok, deductions: { lab: 2 } },
      { ...ok, category_rates: { Lab: 1.5 } },
      { ...ok, threshold: -1 },
      { ...ok, threshold: 10.001 },
      { ...ok, threshold: null },
      { ...ok, minimum_guarantee: 1e10 },
    ])
      expect(parseRule(bad), JSON.stringify(bad)).toBeNull();
    expect(parseRule({ ...ok, default_rate: 0.3325 })).not.toBeNull();
    expect(parseRule({ ...ok, default_rate: 1, deductions: { lab: 0 } })).not.toBeNull();
  });

  it("refuses category names with spaces around them, empty, too long, or more than 30 categories", () => {
    for (const bad of [
      { ...ok, category_rates: { " Lab": 0.1 } },
      { ...ok, category_rates: { "": 0.1 } },
      { ...ok, category_rates: { ["x".repeat(61)]: 0.1 } },
      {
        ...ok,
        category_rates: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`C${i}`, 0.1])),
      },
    ])
      expect(parseRule(bad)).toBeNull();
  });

  it("cleanRule drops undefined keys so the stored JSON is what was validated", () => {
    expect(Object.keys(cleanRule({ ...ok, threshold: undefined }))).not.toContain("threshold");
  });

  it("summarises a rule in words", () => {
    expect(ruleSummary(ok)).toBe(
      "35% of net revenue; Lab 10%; above 1,000.5 a month; less lab 100%; at least 0 a month",
    );
    expect(ruleSummary(rule({ default_rate: 0.3 }))).toBe("30% of net revenue; no deductions");
  });
});

describe("the scheme form", () => {
  const cats = ["Consultation", "Lab", "Unmapped"];
  it("turns percentages into rates", () => {
    expect(percentToRate("35")).toBe(0.35);
    expect(percentToRate("33.25 %")).toBe(0.3325);
    expect(percentToRate("")).toBeUndefined();
    expect(percentToRate("1e2")).toBeNaN();
    expect(percentToRate("33.255")).toBeNaN();
    const r = ruleFromForm(
      {
        default_pct: "30",
        cat_name_0: "Lab",
        cat_pct_0: "10",
        cat_name_1: "",
        cat_pct_1: "",
        ded_lab_pct: "100",
        ded_referral_pct: "50",
        ded_consumables_pct: "",
        threshold: "20,000",
        guarantee: "",
      },
      cats,
    );
    expect(r).toEqual({
      ok: true,
      rule: {
        basis: "net_revenue",
        default_rate: 0.3,
        category_rates: { Lab: 0.1 },
        deductions: { lab: 1, referral: 0.5 },
        threshold: 20000,
      },
    });
  });
  it("refuses a missing default, an unknown or repeated category, and a rate above 100 %", () => {
    expect(ruleFromForm({ default_pct: "" }, cats)).toMatchObject({
      ok: false,
      error: /Default rate/,
    });
    expect(
      ruleFromForm({ default_pct: "30", cat_name_0: "Dental", cat_pct_0: "5" }, cats),
    ).toMatchObject({
      ok: false,
      error: /not a service category/,
    });
    expect(
      ruleFromForm(
        { default_pct: "30", cat_name_0: "Lab", cat_pct_0: "5", cat_name_1: "Lab", cat_pct_1: "6" },
        cats,
      ),
    ).toMatchObject({ ok: false, error: /two rates/ });
    expect(ruleFromForm({ default_pct: "130" }, cats)).toMatchObject({
      ok: false,
      error: /Default rate/,
    });
    expect(ruleFromForm({ default_pct: "30", threshold: "abc" }, cats)).toMatchObject({
      ok: false,
      error: /Threshold/,
    });
  });
});

describe("charges CSV", () => {
  it("reads a valid file (BOM, quotes, upper-cases the doctor)", () => {
    const r = parseChargesCsv(
      '﻿month,doctor_dha_id,kind,amount,reference,note\n2026-09,syn-0001,lab,"1,250.50",LAB-1,"monthly, lab"\n2026-09-01,SYN-0002,Referral,100,,\n',
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          month: "2026-09-01",
          doctor_dha_id: "SYN-0001",
          kind: "lab",
          amount: 1250.5,
          reference: "LAB-1",
          note: "monthly, lab",
        },
        {
          month: "2026-09-01",
          doctor_dha_id: "SYN-0002",
          kind: "referral",
          amount: 100,
          reference: null,
          note: null,
        },
      ],
    });
  });
  it("refuses unknown or missing columns, bad kinds, zero amounts and bad months, naming the row", () => {
    expect(parseChargesCsv("month,doctor_dha_id,kind,amount,patient\n")).toMatchObject({
      ok: false,
    });
    expect(parseChargesCsv("month,doctor_dha_id,amount\n")).toMatchObject({ ok: false });
    expect(parseChargesCsv("month,doctor_dha_id,kind,amount\n")).toMatchObject({
      ok: false,
      errors: ["The file has no rows."],
    });
    const bad = parseChargesCsv(
      "month,doctor_dha_id,kind,amount\n2026-13,SYN-1,lab,10\n2026-09,SYN-1,rent,10\n2026-09,SYN-1,lab,0\n2026-09,,lab,5\n",
    );
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join(" ");
    for (const s of ["Row 2", "Row 3", "Row 4", "Row 5"]) expect(errors).toContain(s);
  });
});

describe("trail CSV", () => {
  it("has the run's sign-offs, every step per doctor, payments and no formulas", () => {
    const snap = buildRunSnapshot(inputsFromFixture());
    snap.results[0].doctor_name = "=HYPERLINK(1)";
    const csv = runTrailCsv(snap, {
      status: "posted",
      snapshot_hash: "a".repeat(64),
      built_at: "2026-10-05T08:00:00Z",
      verified_by: "Fin User",
      verified_at: "2026-10-06T08:00:00Z",
      approved_by: "Ceo User",
      approved_at: "2026-10-07T08:00:00Z",
      posted_ref: "JV-0001",
      posted_at: "2026-10-08T08:00:00Z",
      lines: [{ doctor_dha_id: "SYN-0001", paid_on: "2026-10-10", payment_ref: "TRF-1" }],
    });
    expect(csv.split("\r\n")[0]).toContain(
      "month,doctor_dha_id,doctor_name,scheme_version,rule_sha256,step,item",
    );
    expect(csv).toContain("a".repeat(64));
    expect(csv).toContain("Fin User");
    expect(csv).toContain("JV-0001");
    expect(csv).toContain("TRF-1");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toMatch(/SYN-0002,Dr Synthetic Two,1,f+,earned,Consultation,3200,0.615385,1969.23/);
    expect(csv).toMatch(/SYN-0003,,1,f+,payout,guarantee,,,5000/);
    expect(csv).toContain("no approved scheme");
  });
});
