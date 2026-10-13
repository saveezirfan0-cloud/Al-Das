/**
 * The chart of accounts (pure): natures, control kinds, the tree and its checks. The database (acc_account_guard) is the
 * authority; these mirror its rules for the UI.
 */

export const NATURES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountNature = (typeof NATURES)[number];

export const NATURE_LABELS: Record<AccountNature, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};

export const CONTROL_KINDS = [
  "receivable",
  "payable",
  "bank",
  "cash",
  "vat_output",
  "vat_input",
  "clearing",
  "retained_earnings",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const CONTROL_LABELS: Record<ControlKind, string> = {
  receivable: "Receivable",
  payable: "Payable",
  bank: "Bank",
  cash: "Cash",
  vat_output: "VAT output",
  vat_input: "VAT input",
  clearing: "Clearing",
  retained_earnings: "Retained earnings",
};

/** The VAT return (VAT 201 box 1) splits standard-rated supplies by emirate; each branch names its emirate. */
export const EMIRATES = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Umm Al Quwain",
  "Ras Al Khaimah",
  "Fujairah",
] as const;

export const ACCOUNT_CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;

export type AccountRow = {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  nature: AccountNature;
  is_group: boolean;
  is_active: boolean;
  is_system: boolean;
  control: ControlKind | null;
  allow_manual: boolean;
  affects_gross_profit?: boolean;
  tally_group?: string | null;
  sort_order?: number;
};

export type TreeNode<T extends AccountRow = AccountRow> = T & { depth: number; path: string[] };

/**
 * The accounts in tree order (each group followed by its children, groups first, then by sort order and code), with their
 * depth and the names of their ancestors. Orphans (a parent missing from the list) are shown at the top level; a cycle
 * cannot be built (the database refuses it), but would end the walk.
 */
export function flattenTree<T extends AccountRow>(rows: readonly T[]): Array<TreeNode<T>> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  const order = (a: T, b: T) =>
    Number(b.is_group) - Number(a.is_group) ||
    (a.sort_order ?? 100) - (b.sort_order ?? 100) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const out: Array<TreeNode<T>> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, path: string[]) => {
    for (const r of [...(byParent.get(parent) ?? [])].sort(order)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, depth, path });
      if (r.is_group) walk(r.id, depth + 1, [...path, r.name]);
    }
  };
  walk(null, 0, []);
  return out;
}

/** Ledgers a journal line may use: active, not groups. Sorted by code. */
export function postableAccounts<T extends AccountRow>(rows: readonly T[]): T[] {
  return rows
    .filter((r) => !r.is_group && r.is_active)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Can this account take a manual journal line (a control account only in an opening-balance journal)? */
export function manualAllowed(
  a: { control: string | null; allow_manual: boolean },
  opening: boolean,
): boolean {
  if (opening) return true;
  return a.control === null && a.allow_manual;
}

/** Problems with a new or edited account before it reaches the database (same codes as the database). */
export function accountProblems(
  input: { code: string; isGroup: boolean; parentId: string | null; control: string | null },
  parent: Pick<AccountRow, "is_group"> | null,
): string[] {
  const out: string[] = [];
  if (!ACCOUNT_CODE_RE.test(input.code)) out.push("invalid");
  if (!input.parentId || !parent) out.push("parent_not_group");
  else if (!parent.is_group) out.push("parent_not_group");
  if (input.isGroup && input.control) out.push("invalid");
  return out;
}

/** Every descendant id of a group (for "is this a child of" checks in the UI). */
export function descendantIds(rows: readonly AccountRow[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const r of rows)
      if (r.parent_id === cur && !out.has(r.id)) {
        out.add(r.id);
        queue.push(r.id);
      }
  }
  return out;
}
