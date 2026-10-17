import { describe, expect, it } from "vitest";

import { type DecisionRow, ruleHistory, ruleMayAuto } from "@/lib/finance/match-rule-gate";
import type { RuleMonth } from "@/lib/finance/match-v2-types";

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  rule: "reference",
  decidedAt: "2026-09-10T10:00:00Z",
  decision: "accepted",
  auto: false,
  undone: false,
  ...over,
});
const S = { minPrecision: 99, minMonths: 2, minDecisions: 20 };
const month = (m: string, right: number, wrong: number): RuleMonth => ({ rule: "reference", month: m, right, wrong });

describe("ruleHistory", () => {
  it("counts right and wrong per rule and UTC month, ignoring manual", () => {
    const rows = [
      row({}),
      row({ auto: true }),
      row({ decision: "rejected" }),
      row({ undone: true }),
      row({ rule: "manual" }),
      row({ rule: "payer_sum", decidedAt: "2026-10-01T00:00:00Z" }),
      row({ decidedAt: "2026-08-31T23:59:59Z" }),
    ];
    expect(ruleHistory(rows)).toEqual([
      { rule: "payer_sum", month: "2026-10", right: 1, wrong: 0 },
      { rule: "reference", month: "2026-08", right: 1, wrong: 0 },
      { rule: "reference", month: "2026-09", right: 1, wrong: 2 },
    ]);
  });
  it("counts an automatic match nobody undid for nothing, and one that was undone as wrong", () => {
    const rows = [row({ auto: true }), row({ auto: true }), row({ auto: true, undone: true })];
    expect(ruleHistory(rows)).toEqual([{ rule: "reference", month: "2026-09", right: 0, wrong: 1 }]);
  });
  it("is empty without rows", () => {
    expect(ruleHistory([])).toEqual([]);
  });
});

describe("ruleMayAuto", () => {
  it("passes with two good months, the latest good", () => {
    const r = ruleMayAuto([month("2026-08", 100, 0), month("2026-09", 99, 1)], "reference", S);
    expect(r.ok).toBe(true);
    expect(r.months.map((m) => m.qualifies)).toEqual([true, true]);
  });
  it("floors the precision, never rounds up", () => {
    const r = ruleMayAuto([month("2026-08", 989, 11), month("2026-09", 989, 11)], "reference", { ...S, minPrecision: 99 });
    expect(r.months[0].precision).toBe(98.9);
    expect(r.ok).toBe(false);
  });
  it("needs enough decisions in a month", () => {
    const r = ruleMayAuto([month("2026-08", 19, 0), month("2026-09", 50, 0)], "reference", S);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Needs 2 months with at least 20 decisions at 99% or better; has 1.");
  });
  it("fails when the latest eligible month dropped", () => {
    const r = ruleMayAuto([month("2026-07", 100, 0), month("2026-08", 100, 0), month("2026-09", 90, 10)], "reference", S);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2026-09");
  });
  it("ignores a recent month with too few decisions when judging the latest", () => {
    const r = ruleMayAuto([month("2026-08", 100, 0), month("2026-09", 100, 0), month("2026-10", 1, 1)], "reference", S);
    expect(r.ok).toBe(true);
  });
  it("is not ok without history or for another rule", () => {
    expect(ruleMayAuto([], "reference", S).ok).toBe(false);
    expect(ruleMayAuto([month("2026-08", 100, 0), month("2026-09", 100, 0)], "payer_sum", S).ok).toBe(false);
  });
});
