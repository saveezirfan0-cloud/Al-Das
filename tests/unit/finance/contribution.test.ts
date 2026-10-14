import { describe, expect, it } from "vitest";

import {
  buildContribution,
  parseContributionInputs,
  PROVISIONAL_LABEL,
  type ContributionInputs,
  type ContributionReport,
  type DoctorLine,
} from "@/lib/finance/contribution";

import fixture from "./fixtures/m2a-contribution.synthetic.json";

const inputs = (): ContributionInputs => parseContributionInputs(structuredClone(fixture.expected));
const build = (i: ContributionInputs = inputs(), canSeePay = true) =>
  buildContribution(i, { canSeePay, branchNames: { P: "Palm", M: "Marina" } });
const doctors = (r: ContributionReport) =>
  new Map<string, DoctorLine>(
    r.clinics.flatMap((c) => c.departments.flatMap((d) => d.doctors.map((x) => [x.key, x]))),
  );
const pick = <T extends object>(o: T, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
const LEVEL_KEYS = Object.keys(fixture.result.total);

describe("contribution levels (L3, L5, L6)", () => {
  it("matches the hand-worked fixture at every level", () => {
    const r = build();
    for (const c of r.clinics)
      expect(pick(c, LEVEL_KEYS), c.key).toEqual(
        fixture.result.clinics[c.key as keyof typeof fixture.result.clinics],
      );
    expect(pick(r.total, LEVEL_KEYS)).toEqual(fixture.result.total);
    const docs = doctors(r);
    expect(docs.size).toBe(Object.keys(fixture.result.doctors).length);
    for (const [k, v] of Object.entries(fixture.result.doctors))
      expect(pick(docs.get(k)!, ["status", "pay", "charges", "contribution"]), k).toEqual(v);
  });

  it("labels clinics by branch name, the unknown branch plainly, departments and doctors by revenue", () => {
    const r = build();
    expect(r.clinics.map((c) => c.label)).toEqual(["Palm", "Marina", "Branch not mapped"]);
    expect(r.clinics[0].departments.map((d) => d.label)).toEqual([
      "General Medicine",
      "Dermatology",
    ]);
    expect(r.clinics[0].departments[0].doctors.map((d) => d.name)).toEqual([
      "Dr Demo-01",
      "Dr Demo-02",
    ]);
  });

  it("department = sum of its doctors; clinic = sum of departments; L5 and L6 follow", () => {
    const r = build();
    for (const c of r.clinics) {
      const sum = (f: (d: (typeof c.departments)[number]) => number) =>
        Math.round(c.departments.reduce((a, d) => a + f(d), 0) * 1000) / 1000;
      expect(sum((d) => d.revenue)).toBe(c.revenue);
      expect(sum((d) => d.contribution ?? 0)).toBe(c.contribution ?? 0);
      for (const d of c.departments) {
        const covered = d.doctors.filter((x) => x.status === "linked");
        expect(
          Math.round(covered.reduce((a, x) => a + (x.contribution ?? 0), 0) * 1000) / 1000,
        ).toBe(d.contribution ?? 0);
      }
      if (c.l5 !== null) expect(c.l6).toBe(Math.round((c.l5 - c.allocated) * 1000) / 1000);
    }
  });

  it("splits a doctor's pay and charges over every row of that DHA id, so nothing is counted twice", () => {
    const r = build();
    const d01 = [...doctors(r).values()].filter((d) => d.dhaId === "D0001");
    expect(d01).toHaveLength(3); // two branches and two report spellings
    expect(Math.round(d01.reduce((a, d) => a + (d.pay ?? 0), 0) * 1000) / 1000).toBe(6000);
    expect(Math.round(d01.reduce((a, d) => a + (d.charges ?? 0), 0) * 1000) / 1000).toBe(300);
  });

  it("keeps the allocated shared overhead as its own line, separate from branch overheads", () => {
    const r = build();
    const p = r.clinics.find((c) => c.branchCode === "P")!;
    expect(p.branchOverhead).toBe(1000); // Cleaning, P only
    expect(p.allocated).toBe(6950); // Rent 9000 × 13500/18000 + Admin 600 / 3
    expect(p.l5).toBe(2800);
    expect(p.l6).toBe(-4150);
    // an overhead for a branch with no revenue is not hidden in another branch
    expect(r.reasons.some((x) => x.includes("Overheads of G"))).toBe(true);
  });
});

describe("pay is never assumed", () => {
  it("an unmapped doctor shows revenue with pay not linked and is left out of contribution", () => {
    const d = doctors(build()).get("P|Dermatology|demo-04")!;
    expect(d).toMatchObject({ status: "not_linked", revenue: 1000, pay: null, contribution: null });
    const derm = build().clinics[0].departments.find((x) => x.label === "Dermatology")!;
    expect(derm.contribution).toBeNull(); // no doctor with pay loaded: unknown, not revenue
    expect(derm.coverage).toBe(0);
    expect(build().unlinked).toEqual([{ doctorKey: "demo-04", name: "Dr Demo-04", revenue: 1000 }]);
  });

  it("a zero compensation means unavailable, never zero pay", () => {
    const d = doctors(build()).get("M|Physiotherapy|demo-05")!;
    expect(d.status).toBe("not_loaded");
    const i = inputs();
    i.comp.push({ dha_id: "D0005", amount: 0 });
    expect(doctors(build(i)).get("M|Physiotherapy|demo-05")!.status).toBe("not_loaded");
  });

  it("a month without compensation is Provisional, with the coverage named", () => {
    const i = inputs();
    i.comp = [];
    i.period_approved = true;
    const r = build(i);
    expect(r.provisional).toBe(true);
    expect(r.total.contribution).toBeNull();
    expect(r.total.l5).toBeNull();
    expect(r.total.coverage).toBe(0);
    expect(r.reasons.join(" ")).toContain("Only 0% of revenue has doctor pay loaded");
    expect(PROVISIONAL_LABEL).toBe("Provisional");
  });

  it("is final only when Finance approved the month AND every doctor with revenue has pay loaded", () => {
    const i = inputs();
    expect(build(i).provisional).toBe(true);
    expect(build(i).reasons).toContain("Finance has not approved this month's costs.");
    i.period_approved = true;
    expect(build(i).provisional).toBe(true); // coverage still below 100%
    i.rows = i.rows.map((r) =>
      r.dha_id === null
        ? { ...r, dha_id: "D0004" }
        : r.dha_id === "D0003" || r.dha_id === "D0005"
          ? { ...r, dha_id: "D0002" }
          : r,
    );
    i.comp.push({ dha_id: "D0004", amount: 500 });
    i.doctor_weights.push({ dha_id: "D0004", revenue: 1000, groups: 1 });
    i.branch_overheads = i.branch_overheads.filter((o) => o.branch_code !== "G");
    const r = build(i);
    expect(r.total.coverage).toBe(1);
    expect(r.reasons).toEqual([]);
    expect(r.provisional).toBe(false);
    // ...and a partly covered month stays provisional
    i.coverage = [{ from: "2026-09-01", to: "2026-09-20" }];
    expect(build(i).provisional).toBe(true);
  });

  it("parses the SQL output strictly", () => {
    expect(() => parseContributionInputs({})).toThrow();
    expect(() =>
      parseContributionInputs({
        ...fixture.expected,
        shared_overheads: [{ pool: "X", amount: 1, basis: "magic" }],
      }),
    ).toThrow();
  });
});

describe("compensation visibility", () => {
  it("without finance.costs.compensation no individual pay or doctor contribution is in the result", () => {
    const r = build(inputs(), false);
    expect(r.canSeePay).toBe(false);
    for (const d of doctors(r).values()) {
      expect(d.pay).toBeNull();
      expect(d.contribution).toBeNull();
    }
    for (const c of r.clinics) {
      expect(c.pay).toBeNull();
      for (const d of c.departments) expect(d.pay).toBeNull();
    }
    expect(r.total.pay).toBeNull();
    // no pay figure (or a doctor's L3) survives anywhere in the object
    const values = new Set<number>();
    JSON.stringify(r, (_k, v: unknown) => {
      if (typeof v === "number") values.add(v);
      return v;
    });
    for (const v of [4000, 1333.333, 666.667, 1800, 7000, 10000])
      expect(values.has(v), String(v)).toBe(false);
  });

  it("shows department and clinic totals that include pay when at least two doctors' pay is in them", () => {
    const r = build(inputs(), false);
    const p = r.clinics.find((c) => c.branchCode === "P")!;
    expect(p.withheld).toBe(false);
    expect(p.contribution).toBe(3800);
    expect(p.l5).toBe(2800);
    expect(p.departments.find((d) => d.label === "General Medicine")!.contribution).toBe(3800);
  });

  it("withholds a total whose pay comes from one doctor, its sibling departments and the grand total", () => {
    const r = build(inputs(), false);
    const m = r.clinics.find((c) => c.branchCode === "M")!;
    expect(m).toMatchObject({ withheld: true, contribution: null, l5: null, l6: null });
    expect(m.departments.every((d) => d.withheld && d.contribution === null)).toBe(true);
    const unknown = r.clinics.find((c) => c.branchCode === null)!;
    expect(unknown.withheld).toBe(true);
    // total − Palm would give the others away, so the total is withheld too
    expect(r.total).toMatchObject({ withheld: true, contribution: null, l5: null, l6: null });
    // revenue, charges, overheads and the allocated line stay visible
    expect(m.revenue).toBe(3800);
    expect(m.allocated).toBe(2100);
    expect(r.total.allocated).toBe(9600);
  });

  it("with the permission nothing is withheld", () => {
    const r = build(inputs(), true);
    expect(r.clinics.some((c) => c.withheld)).toBe(false);
    expect(r.total.withheld).toBe(false);
  });
});

describe("restricted to one branch", () => {
  it("shows that branch's share of a doctor's pay and of the shared pools, never the whole", () => {
    const i = inputs();
    i.rows = i.rows.filter((r) => r.branch_code === "P");
    i.branch_overheads = i.branch_overheads.filter((o) => o.branch_code === "P");
    const r = build(i);
    expect(r.clinics).toHaveLength(1);
    expect(doctors(r).get("P|General Medicine|demo-01")!.pay).toBe(4000); // not 6000
    expect(r.total.allocated).toBe(6950);
    expect(r.total.l5).toBe(2800);
  });
});
