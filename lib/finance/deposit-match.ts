import {
  daysBetween,
  toleranceCents,
  type BankLine,
  type BankSettings,
} from "@/lib/finance/bank-recon";

/**
 * Insurer deposits against insurer payments (pure, deterministic). One bank credit can be one payment reference, or the
 * total of several (an insurer often pays many references in one transfer), and two payments can have the same amount.
 * This lists every payment, or group of payments of the same payer, that could explain the deposit and decides only when
 * that is safe; otherwise the candidates are SHOWN and a person chooses. It never guesses.
 *
 *   matched      exactly one candidate, or exactly one whose reference(s) appear on the bank line
 *   ambiguous    several candidates and nothing on the bank line tells them apart
 *   combination  no single payment fits but one group does (a proposal: the amounts alone prove nothing)
 *   review       a payment's reference is on the bank line but its amount is outside the tolerance (a part payment,
 *                a fee or a take-back): shown with the difference
 *   unmatched    nothing fits
 *
 * The amount tolerance and date window are the bank settings (fin_ref_finance_settings); `maxParts` and `maxPool` bound
 * the search for groups and come from the caller's settings too. Payment keys are the caller's (a payment reference).
 */

export type InsurancePayment = {
  key: string;
  ref: string | null;
  payerId: string | null;
  date: string;
  amount: number;
};

export type DepositSettings = BankSettings & {
  /** The most payments one deposit may be a total of. */
  maxParts: number;
  /** The most payments considered for a group; above it no group is offered (singles still are). */
  maxPool: number;
};

export type DepositCandidate = {
  keys: string[];
  amount: number;
  /** Deposit minus the candidate's total. */
  amountDiff: number;
  dayDiff: number;
  /** How many of the candidate's payments have their reference on the bank line. */
  refsFound: number;
};

export type DepositStatus = "matched" | "ambiguous" | "combination" | "review" | "unmatched";
export type DepositResult = {
  status: DepositStatus;
  candidates: DepositCandidate[];
  /** Groups were not searched because too many payments were in range. */
  poolTooLarge: boolean;
};

const MAX_LISTED = 25;
const cents = (n: number) => Math.round(n * 100);
const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function matchDeposit(
  deposit: BankLine,
  payments: readonly InsurancePayment[],
  s: DepositSettings,
): DepositResult {
  const empty: DepositResult = { status: "unmatched", candidates: [], poolTooLarge: false };
  if (deposit.amount <= 0) return empty;

  const text = norm(`${deposit.reference ?? ""} ${deposit.description ?? ""}`);
  const refFound = (p: InsurancePayment) => norm(p.ref).length >= 4 && text.includes(norm(p.ref));
  const tol = toleranceCents(deposit.amount, s);
  const inWindow = payments
    .filter((p) => p.amount > 0 && Math.abs(daysBetween(p.date, deposit.valueDate)) <= s.windowDays)
    .sort((a, b) => a.key.localeCompare(b.key));

  const build = (group: readonly InsurancePayment[]): DepositCandidate => {
    const total = group.reduce((a, p) => a + cents(p.amount), 0);
    return {
      keys: group.map((p) => p.key),
      amount: total / 100,
      amountDiff: (cents(deposit.amount) - total) / 100,
      dayDiff: Math.max(...group.map((p) => Math.abs(daysBetween(p.date, deposit.valueDate)))),
      refsFound: group.filter(refFound).length,
    };
  };
  const fits = (c: DepositCandidate) => Math.abs(cents(c.amountDiff)) <= tol;

  const singles = inWindow.map((p) => build([p])).filter(fits);

  // groups of 2..maxParts payments of one payer
  const combos: DepositCandidate[] = [];
  let poolTooLarge = false;
  if (s.maxParts >= 2) {
    const byPayer = new Map<string, InsurancePayment[]>();
    for (const p of inWindow)
      byPayer.set(p.payerId ?? "", [...(byPayer.get(p.payerId ?? "") ?? []), p]);
    for (const pool of byPayer.values()) {
      if (pool.length < 2) continue;
      if (pool.length > s.maxPool) {
        poolTooLarge = true;
        continue;
      }
      const walk = (start: number, chosen: InsurancePayment[]) => {
        if (chosen.length >= 2) {
          const c = build(chosen);
          if (fits(c)) combos.push(c);
        }
        if (chosen.length === s.maxParts) return;
        for (let i = start; i < pool.length; i++) walk(i + 1, [...chosen, pool[i]]);
      };
      walk(0, []);
    }
  }

  const order = (a: DepositCandidate, b: DepositCandidate) =>
    b.refsFound - a.refsFound ||
    a.keys.length - b.keys.length ||
    Math.abs(a.amountDiff) - Math.abs(b.amountDiff) ||
    a.dayDiff - b.dayDiff ||
    a.keys.join("|").localeCompare(b.keys.join("|"));
  const all = [...singles, ...combos].sort(order);
  const listed = all.slice(0, MAX_LISTED);
  const result = (status: DepositStatus, candidates = listed): DepositResult => ({
    status,
    candidates,
    poolTooLarge,
  });

  if (all.length === 0) {
    const named = inWindow.filter(refFound).map((p) => build([p]));
    return named.length > 0
      ? result("review", named.sort(order).slice(0, MAX_LISTED))
      : result("unmatched", []);
  }
  const confirmed = all.filter((c) => c.refsFound === c.keys.length);
  if (confirmed.length === 1) return result("matched", confirmed);
  if (confirmed.length === 0 && all.length === 1) {
    return result(all[0].keys.length === 1 ? "matched" : "combination");
  }
  return result("ambiguous");
}
