/**
 * End-of-day cash-up rules (pure). The SQL functions fin_cashup_refresh / fin_cashup_submit enforce the same rules at
 * submit time; this module drives the form (live variance, which lines need a reason, whether the button may be pressed).
 */

export type CashupLineInput = {
  mode: string;
  expected: number;
  counted: number | null;
  reason: string | null;
};

export type CashupLineResult = CashupLineInput & {
  variance: number | null;
  needsReason: boolean;
};

export type CashupSummary = {
  lines: CashupLineResult[];
  expectedTotal: number;
  countedTotal: number;
  varianceTotal: number;
  problems: string[];
  canSubmit: boolean;
};

const cents = (n: number) => Math.round(n * 100);

export function summariseCashup(
  lines: readonly CashupLineInput[],
  tolerance: number,
): CashupSummary {
  const tolC = cents(tolerance);
  const results = lines.map((l): CashupLineResult => {
    const variance = l.counted === null ? null : (cents(l.counted) - cents(l.expected)) / 100;
    const needsReason = variance !== null && Math.abs(cents(variance)) > tolC;
    return { ...l, variance, needsReason };
  });
  const problems: string[] = [];
  if (results.some((l) => l.counted === null))
    problems.push("Count every payment mode (enter 0 where nothing was taken).");
  if (results.some((l) => l.needsReason && !(l.reason ?? "").trim()))
    problems.push("Give a reason for every difference above the tolerance.");
  const sum = (f: (l: CashupLineResult) => number) =>
    results.reduce((a, l) => a + cents(f(l)), 0) / 100;
  return {
    lines: results,
    expectedTotal: sum((l) => l.expected),
    countedTotal: sum((l) => l.counted ?? 0),
    varianceTotal: sum((l) => l.variance ?? 0),
    problems,
    canSubmit: problems.length === 0,
  };
}
