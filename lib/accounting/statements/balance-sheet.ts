import {
  cents,
  dateLabel,
  fromCents,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";
import { treeRows, type StatementAccount } from "@/lib/accounting/statements/tree";

/**
 * Balance sheet by group tree (pure). Capital Account (with Reserves & Surplus) is equity; the current fiscal year's
 * profit and earlier years' profit not yet closed (until the year-end close, 22I) are shown as lines in equity. Then
 * Loans, Current Liabilities, Suspense and Branch / Divisions; then Fixed Assets, Investments, Current Assets and Misc.
 * Expenses (asset). Balances are in natural sign. One column per as-at date (a comparison adds a second).
 */

export type BsData = {
  as_at: string;
  entity_id: string | null;
  fy_start: string;
  include_adjustment: boolean;
  provisional: boolean;
  rows: Array<{ account_id: string; nature: string; balance: number }>;
  current_year_pl: number;
  earlier_years_pl: number;
  totals: { assets: number; liabilities: number; equity: number; difference: number };
};

const LIAB_ORDER = ["G-CAP", "G-LOAN", "G-CL", "G-SUSP", "G-BR"];
const ASSET_ORDER = ["G-FA", "G-INV", "G-CA", "G-MISC"];

function ordered(roots: readonly StatementAccount[], order: string[]): StatementAccount[] {
  const rank = (a: StatementAccount) => {
    const i = order.indexOf(a.code);
    return i < 0 ? order.length : i;
  };
  return [...roots].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.sort_order ?? 100) - (b.sort_order ?? 100) ||
      (a.code < b.code ? -1 : 1),
  );
}

export type BalanceSheet = {
  headers: string[];
  assets: number[];
  equity: number[];
  liabilities: number[];
  /** equity + profit lines + liabilities */
  capitalAndLiabilities: number[];
  difference: number[];
  balanced: boolean;
  table: ReportTable;
};

export function buildBalanceSheet(
  accounts: readonly StatementAccount[],
  data: readonly BsData[],
  opts: {
    headers?: string[];
    hrefFor?: (a: StatementAccount) => string | null;
    groupsOnly?: boolean;
  } = {},
): BalanceSheet {
  const width = data.length;
  const values = new Map<string, number[]>();
  data.forEach((d, i) => {
    for (const r of d.rows) {
      const v = values.get(r.account_id) ?? new Array<number>(width).fill(0);
      v[i] += cents(r.balance);
      values.set(r.account_id, v);
    }
  });
  const roots = accounts.filter((a) => !a.parent_id);
  const eqRoots = ordered(
    roots.filter((r) => r.nature === "equity"),
    LIAB_ORDER,
  );
  const liRoots = ordered(
    roots.filter((r) => r.nature === "liability"),
    LIAB_ORDER,
  );
  const asRoots = ordered(
    roots.filter((r) => r.nature === "asset"),
    ASSET_ORDER,
  );
  const rows: ReportRow[] = [];
  const v = (x: number[]) => x.map(fromCents);
  const tree = (rs: StatementAccount[]) => {
    const total = new Array<number>(width).fill(0);
    for (const r of rs) {
      const t = treeRows(accounts, values, width, {
        roots: [r],
        depth0: 1,
        hrefFor: opts.hrefFor,
        groupsOnly: opts.groupsOnly,
      });
      rows.push(...t.rows);
      t.total.forEach((x, i) => (total[i] += x));
    }
    return total;
  };

  rows.push({ label: "Capital and liabilities", depth: 0, kind: "heading", values: [] });
  const eq = tree(eqRoots);
  const cur = data.map((d) => cents(d.current_year_pl));
  const earlier = data.map((d) => cents(d.earlier_years_pl));
  const fyLabel = data[0] ? ` (fiscal year from ${dateLabel(data[0].fy_start)})` : "";
  if (cur.some((x) => x !== 0))
    rows.push({
      label: `Profit for the current year${fyLabel}`,
      depth: 1,
      kind: "ledger",
      values: v(cur),
    });
  if (earlier.some((x) => x !== 0))
    rows.push({
      label: "Earlier years' profit not yet closed into reserves",
      depth: 1,
      kind: "ledger",
      values: v(earlier),
    });
  const equityTotal = eq.map((x, i) => x + cur[i] + earlier[i]);
  rows.push({
    label: "Total capital and reserves",
    depth: 0,
    kind: "subtotal",
    values: v(equityTotal),
  });
  const li = tree(liRoots);
  rows.push({ label: "Total liabilities", depth: 0, kind: "subtotal", values: v(li) });
  const capLi = equityTotal.map((x, i) => x + li[i]);
  rows.push({ label: "Total capital and liabilities", depth: 0, kind: "total", values: v(capLi) });

  rows.push({ label: "Assets", depth: 0, kind: "heading", values: [] });
  const as = tree(asRoots);
  rows.push({ label: "Total assets", depth: 0, kind: "total", values: v(as) });

  const diff = as.map((x, i) => x - capLi[i]);
  const balanced = diff.every((x) => x === 0);
  if (!balanced)
    rows.push({
      label:
        "Difference: assets do not equal capital and liabilities (check imports and opening balances)",
      depth: 0,
      kind: "total",
      values: v(diff),
      flag: "warning",
    });
  const headers = opts.headers ?? data.map((d) => `As at ${dateLabel(d.as_at)}`);
  return {
    headers,
    assets: v(as),
    equity: v(equityTotal),
    liabilities: v(li),
    capitalAndLiabilities: v(capLi),
    difference: v(diff),
    balanced,
    table: {
      labelHeader: "Account",
      columns: headers,
      rows,
      empty: "Nothing posted up to this date.",
    },
  };
}
