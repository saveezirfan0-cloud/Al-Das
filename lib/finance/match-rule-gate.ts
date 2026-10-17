import type { AutoRule, MatchRule, RuleMonth } from "@/lib/finance/match-v2-types";

/**
 * "Training under control": a rule may match without a person only after its own track record is good enough,
 * month after month. Pure; the thresholds are passed in (fin_ref_finance_settings), never fixed here.
 */

export type DecisionRow = {
  rule: MatchRule | "manual";
  decidedAt: string; // ISO timestamp
  decision: "accepted" | "rejected";
  auto: boolean;
  undone: boolean;
};

/**
 * Right = accepted and not undone (by the rule on its own or after a person's yes).
 * Wrong = a person rejected it, or it was accepted and later undone. Manual matches say nothing about a rule.
 */
export function ruleHistory(rows: readonly DecisionRow[]): RuleMonth[] {
  const by = new Map<string, RuleMonth>();
  for (const r of rows) {
    if (r.rule === "manual") continue;
    const month = r.decidedAt.slice(0, 7);
    const key = `${r.rule}|${month}`;
    const m = by.get(key) ?? { rule: r.rule, month, right: 0, wrong: 0 };
    if (r.decision === "accepted" && !r.undone) m.right += 1;
    else m.wrong += 1;
    by.set(key, m);
  }
  return [...by.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.month.localeCompare(b.month));
}

export type GateSettings = { minPrecision: number; minMonths: number; minDecisions: number };
export type GateMonth = { month: string; decisions: number; precision: number; qualifies: boolean };

export function ruleMayAuto(
  history: readonly RuleMonth[],
  rule: AutoRule,
  s: GateSettings,
): { ok: boolean; reason: string; months: GateMonth[] } {
  const months: GateMonth[] = history
    .filter((h) => h.rule === rule)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((h) => {
      const decisions = h.right + h.wrong;
      const precision = decisions === 0 ? 0 : Math.floor((h.right * 10000) / decisions) / 100;
      return { month: h.month, decisions, precision, qualifies: decisions >= s.minDecisions && precision >= s.minPrecision };
    });
  const qualifying = months.filter((m) => m.qualifies).length;
  const enough = months.filter((m) => m.decisions >= s.minDecisions);
  const latest = enough.length ? enough[enough.length - 1] : null;

  if (qualifying < s.minMonths) {
    return {
      ok: false,
      reason: `Needs ${s.minMonths} months with at least ${s.minDecisions} decisions at ${s.minPrecision}% or better; has ${qualifying}.`,
      months,
    };
  }
  if (!latest || !latest.qualifies) {
    return {
      ok: false,
      reason: `The most recent month with enough decisions (${latest?.month ?? "none"}) is below ${s.minPrecision}%.`,
      months,
    };
  }
  return {
    ok: true,
    reason: `${qualifying} months with at least ${s.minDecisions} decisions at ${s.minPrecision}% or better; the latest month (${latest.month}) is ${latest.precision}%.`,
    months,
  };
}
