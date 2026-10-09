import { describe, expect, it } from "vitest";

import { COMPARABLE, diffSets, hashRef, isIdentical, previousDay, retirementReadiness, type DayDiff } from "@/lib/parallel-run/diff";

describe("parallel run diff", () => {
  it("hashes ids with an org salt (no raw ids stored)", () => {
    const h = hashRef("org-a", "PIN123");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("PIN123");
    expect(hashRef("org-a", " PIN123 ")).toBe(h);
    expect(hashRef("org-b", "PIN123")).not.toBe(h);
  });
  it("computes set differences both ways and dedupes", () => {
    const d = diffSets(["a", "b", "b", "c"], ["b", "c", "d"]);
    expect(d).toEqual({ make_count: 3, native_count: 3, only_in_make: ["a"], only_in_native: ["d"] });
    expect(isIdentical(diffSets(["x"], ["x"]))).toBe(true);
    expect(isIdentical(d)).toBe(false);
    expect(diffSets([], [])).toEqual({ make_count: 0, native_count: 0, only_in_make: [], only_in_native: [] });
  });
  it("previousDay is the last complete clinic-local day", () => {
    expect(previousDay(new Date("2026-10-09T21:00:00Z"))).toBe("2026-10-09"); // 01:00 on the 10th in Dubai
    expect(previousDay(new Date("2026-10-09T05:00:00Z"))).toBe("2026-10-08");
    expect(previousDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
  });
  it("only id-set scenarios are comparable today; Token / MRD sync wait for Phase 6", () => {
    expect([...COMPARABLE].sort()).toEqual(["appointment_reminders", "birthday", "chronic_recall", "chronic_update"]);
  });

  const day = (n: number, over: Partial<DayDiff> = {}): DayDiff => ({ run_date: `2026-10-${String(n).padStart(2, "0")}`, make_count: 10, native_count: 10, only_in_make: [], only_in_native: [], explained: false, ...over });
  it("a scenario can be retired only after 7 explained days with the native side built", () => {
    const week = Array.from({ length: 7 }, (_, i) => day(i + 1));
    expect(retirementReadiness({ native_built: true, days: week })).toEqual({ ready: true, reasons: [] });
    expect(retirementReadiness({ native_built: false, days: week }).ready).toBe(false);
    expect(retirementReadiness({ native_built: true, days: week.slice(0, 5) }).reasons[0]).toContain("5 of 7");
    const withDiff = [...week.slice(0, 6), day(7, { only_in_make: ["x"] })];
    expect(retirementReadiness({ native_built: true, days: withDiff }).reasons.join()).toContain("unexplained");
    const explained = [...week.slice(0, 6), day(7, { only_in_make: ["x"], explained: true })];
    expect(retirementReadiness({ native_built: true, days: explained }).ready).toBe(true);
  });
});
