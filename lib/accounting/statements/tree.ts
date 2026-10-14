import { flattenTree, type AccountRow } from "@/lib/accounting/accounts";
import type { ReportRow } from "@/lib/accounting/statements/report";

/**
 * Account-tree helpers shared by the statements (pure). Values are arrays of integer cents, one per column; a group
 * carries the sum of everything under it.
 */

export type StatementAccount = AccountRow & {
  affects_gross_profit?: boolean;
  cash_flow_class?: string | null;
  ct_treatment?: string | null;
};

/** The top-level group (root) each account sits under. */
export function rootOf(accounts: readonly StatementAccount[]): Map<string, StatementAccount> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, StatementAccount>();
  for (const a of accounts) {
    let cur: StatementAccount = a;
    for (let i = 0; i < 64 && cur.parent_id && byId.has(cur.parent_id); i++)
      cur = byId.get(cur.parent_id)!;
    out.set(a.id, cur);
  }
  return out;
}

/** The codes of every system group above an account (and its own when it is one), nearest first. */
export function systemAncestors(accounts: readonly StatementAccount[]): Map<string, string[]> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, string[]>();
  for (const a of accounts) {
    const codes: string[] = [];
    let cur: StatementAccount | undefined = a;
    for (let i = 0; i < 64 && cur; i++) {
      if (cur.is_system) codes.push(cur.code);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(a.id, codes);
  }
  return out;
}

/** Is the account at or under the system group `code`? */
export function under(ancestors: Map<string, string[]>, accountId: string, code: string): boolean {
  return (ancestors.get(accountId) ?? []).includes(code);
}

/**
 * Report rows for the accounts under `roots` that carry a value: each group followed by its children, with sums.
 * `depth0` is the depth of the roots in the report. Values on accounts missing from the list are left out.
 */
export function treeRows(
  accounts: readonly StatementAccount[],
  values: Map<string, number[]>,
  width: number,
  opts: {
    roots: readonly StatementAccount[];
    depth0?: number;
    hrefFor?: (a: StatementAccount) => string | null;
    groupsOnly?: boolean;
  },
): { rows: ReportRow[]; total: number[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sums = new Map<string, number[]>();
  const rootIds = new Set(opts.roots.map((r) => r.id));
  const total = new Array<number>(width).fill(0);
  const add = (id: string, v: number[]) => {
    const s = sums.get(id) ?? new Array<number>(width).fill(0);
    for (let i = 0; i < width; i++) s[i] += v[i] ?? 0;
    sums.set(id, s);
  };
  for (const [id, v] of values) {
    // only values under one of the roots
    let cur = byId.get(id);
    const chain: string[] = [];
    for (let i = 0; i < 64 && cur; i++) {
      chain.push(cur.id);
      if (rootIds.has(cur.id)) break;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (!cur || !rootIds.has(cur.id)) continue;
    for (const c of chain) add(c, v);
    for (let i = 0; i < width; i++) total[i] += v[i] ?? 0;
  }
  const subset = accounts.filter((a) => sums.has(a.id) && sums.get(a.id)!.some((x) => x !== 0));
  // flattenTree puts accounts whose parent is not in the subset at the top: the roots
  const flat = flattenTree(subset);
  const depth0 = opts.depth0 ?? 0;
  const rows: ReportRow[] = flat
    .filter((a) => !opts.groupsOnly || a.is_group)
    .map((a) => ({
      label: a.name,
      code: a.code,
      depth: depth0 + a.depth,
      kind: a.is_group ? "group" : "ledger",
      values: sums.get(a.id)!.map((x) => x / 100),
      href: !a.is_group && opts.hrefFor ? opts.hrefFor(a) : null,
    }));
  return { rows, total };
}
