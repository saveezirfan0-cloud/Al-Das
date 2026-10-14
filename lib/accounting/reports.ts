import { flattenTree, type AccountNature, type AccountRow } from "@/lib/accounting/accounts";

/**
 * Report shaping (pure). The database aggregates (acc_trial_balance, acc_ledger, acc_day_book); these turn its jsonb into
 * what a page or a workbook shows. Balances are debit minus credit: positive is a debit balance, negative a credit one.
 */

export type TrialBalanceRow = {
  account_id: string;
  code: string;
  name: string;
  nature: AccountNature;
  parent_id: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
};

export type TrialBalanceData = {
  from: string;
  to: string;
  entity_id: string | null;
  rows: TrialBalanceRow[];
  earlier_years_pl: number;
  totals: { opening: number; debit: number; credit: number; closing: number };
};

export type TrialBalanceLine = {
  id: string;
  code: string;
  name: string;
  depth: number;
  isGroup: boolean;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
};

export type TrialBalance = {
  lines: TrialBalanceLine[];
  earlierYearsPl: number;
  totals: { opening: number; debit: number; credit: number; closing: number };
  /** Debits equal credits and every balance nets to zero. */
  balanced: boolean;
};

const c = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100);
const u = (cents: number) => cents / 100;

/**
 * The trial balance as a tree: every ledger with a balance or movement, under its groups, each group carrying the sum of
 * what is under it. Sums are in cents so they never drift. `groupsOnly` keeps the groups (the summary view).
 */
export function buildTrialBalance(
  accounts: readonly AccountRow[],
  data: Pick<TrialBalanceData, "rows" | "earlier_years_pl">,
  opts: { groupsOnly?: boolean } = {},
): TrialBalance {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sums = new Map<string, { o: number; d: number; c: number }>();
  const add = (id: string, r: TrialBalanceRow) => {
    const s = sums.get(id) ?? { o: 0, d: 0, c: 0 };
    s.o += c(r.opening);
    s.d += c(r.debit);
    s.c += c(r.credit);
    sums.set(id, s);
  };
  let to = 0;
  let td = 0;
  let tc = 0;
  for (const r of data.rows) {
    to += c(r.opening);
    td += c(r.debit);
    tc += c(r.credit);
    add(r.account_id, r);
    // walk up the tree (at most 64 levels, the database's own limit)
    let parent = byId.get(r.account_id)?.parent_id ?? r.parent_id;
    for (let i = 0; parent && i < 64; i++) {
      add(parent, r);
      parent = byId.get(parent)?.parent_id ?? null;
    }
  }
  const known = accounts.filter((a) => sums.has(a.id));
  // rows for accounts missing from the chart list (should not happen) are still shown, at the top level
  const missing: AccountRow[] = data.rows
    .filter((r) => !byId.has(r.account_id))
    .map((r) => ({
      id: r.account_id,
      parent_id: null,
      code: r.code,
      name: r.name,
      nature: r.nature,
      is_group: false,
      is_active: true,
      is_system: false,
      control: null,
      allow_manual: true,
    }));
  const lines = flattenTree([...known, ...missing])
    .filter((a) => !opts.groupsOnly || a.is_group)
    .map((a) => {
      const s = sums.get(a.id)!;
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        depth: a.depth,
        isGroup: a.is_group,
        opening: u(s.o),
        debit: u(s.d),
        credit: u(s.c),
        closing: u(s.o + s.d - s.c),
      };
    });
  const pl = c(data.earlier_years_pl);
  const totals = {
    opening: u(to + pl),
    debit: u(td),
    credit: u(tc),
    closing: u(to + pl + td - tc),
  };
  return {
    lines,
    earlierYearsPl: u(pl),
    totals,
    balanced: td === tc && to + pl === 0,
  };
}

/** A balance as people read it in a ledger: 1,200.00 Dr / 300.00 Cr (zero has no side). */
export function drCr(balance: number): { amount: number; side: "Dr" | "Cr" | "" } {
  const cents = Math.round(balance * 100);
  if (cents === 0) return { amount: 0, side: "" };
  return { amount: Math.abs(cents) / 100, side: cents > 0 ? "Dr" : "Cr" };
}

export type LedgerLine = {
  line_id: string;
  journal_id: string;
  number: string;
  date: string;
  voucher_type: string;
  narration: string;
  description: string | null;
  account_code: string;
  account_name: string;
  branch_code: string | null;
  status: string;
  source_kind: string | null;
  debit: number;
  credit: number;
  balance: number;
};

export type LedgerData = {
  account: { id: string; code: string; name: string; nature: AccountNature; is_group: boolean };
  from: string;
  to: string;
  opening: number;
  period_debit: number;
  period_credit: number;
  closing: number;
  total_lines: number;
  limit: number;
  offset: number;
  lines: LedgerLine[];
};

/** Checks a ledger page: each running balance follows from the one before (used by tests and as a guard in the UI). */
export function ledgerConsistent(data: Pick<LedgerData, "opening" | "lines" | "offset">): boolean {
  if (data.offset !== 0) return true; // a later page starts from a balance the page does not hold
  let bal = c(data.opening);
  for (const l of data.lines) {
    bal += c(l.debit) - c(l.credit);
    if (bal !== c(l.balance)) return false;
  }
  return true;
}

export type DayBookJournal = {
  id: string;
  number: string;
  date: string;
  voucher_type: string;
  narration: string;
  status: string;
  total: number;
  source_kind: string | null;
  reversal_of: string | null;
  reversed_by: string | null;
  lines: Array<{
    line_no: number;
    account_code: string;
    account_name: string;
    debit: number;
    credit: number;
    description: string | null;
  }>;
};

export type DayBookData = {
  from: string;
  to: string;
  entity_id: string | null;
  truncated: boolean;
  journals: DayBookJournal[];
};

/** A sensible default range: the fiscal year to date (from the year's first day to today). */
export function yearToDate(fyStart: string, today: string): { from: string; to: string } {
  return { from: fyStart, to: today < fyStart ? fyStart : today };
}

/** A from / to pair a person typed: both valid dates, from not after to, at most `maxDays` apart. */
export function rangeProblem(from: string, to: string, maxDays = 3660): string | null {
  const ok = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!ok(from) || !ok(to)) return "Enter valid dates.";
  if (from > to) return "The start date is after the end date.";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > maxDays) return "Choose a shorter range.";
  return null;
}
