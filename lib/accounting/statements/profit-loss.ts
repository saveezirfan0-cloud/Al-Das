import {
  cents,
  fromCents,
  pct,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";
import { treeRows, type StatementAccount } from "@/lib/accounting/statements/tree";

/**
 * Profit and loss in Tally's vertical layout (pure): Sales Accounts and Direct Incomes, less Purchase Accounts and
 * Direct Expenses, = gross profit (Tally's "affects gross profit" flag on the ledger); plus Indirect Incomes, less
 * Indirect Expenses, = net profit. The database (acc_profit_and_loss) aggregates per ledger and column; this builds the
 * tree, the subtotals and the extra Total / Change columns. Amounts are in natural sign (income credit minus debit,
 * expense debit minus credit), so a positive net profit is a profit.
 */

export type PlDimension = "none" | "month" | "branch" | "department" | "doctor";

export const PL_DIMENSIONS: Array<{ value: PlDimension; label: string }> = [
  { value: "none", label: "One column" },
  { value: "month", label: "By month" },
  { value: "branch", label: "Branches side by side" },
  { value: "department", label: "By department" },
  { value: "doctor", label: "By doctor" },
];

export type PlTotalsRow = {
  col: string;
  direct_income: number;
  direct_expense: number;
  gross_profit: number;
  indirect_income: number;
  indirect_expense: number;
  net_profit: number;
};

export type PlData = {
  from: string;
  to: string;
  dimension: PlDimension;
  include_adjustment: boolean;
  provisional: boolean;
  columns: string[];
  labels: Record<string, string>;
  rows: Array<{ account_id: string; col: string; amount: number }>;
  totals: PlTotalsRow[];
};

/** Two runs (this period and a comparison) as one dataset with the columns "cur" and "cmp". */
export function mergeComparison(
  cur: PlData,
  cmp: PlData,
  labels: { cur: string; cmp: string },
): PlData {
  const tag = (d: PlData, col: string) => ({
    rows: d.rows.map((r) => ({ ...r, col })),
    totals: d.totals.map((t) => ({ ...t, col })),
  });
  const a = tag(cur, "cur");
  const b = tag(cmp, "cmp");
  return {
    ...cur,
    provisional: cur.provisional || cmp.provisional,
    columns: ["cur", "cmp"],
    labels,
    rows: [...a.rows, ...b.rows],
    totals: [...a.totals, ...b.totals],
  };
}

export type PlSectionKey =
  "direct_income" | "direct_expense" | "indirect_income" | "indirect_expense";

export const PL_SECTIONS: Array<{
  key: PlSectionKey;
  title: string;
  nature: "income" | "expense";
  gp: boolean;
}> = [
  { key: "direct_income", title: "Sales and direct incomes", nature: "income", gp: true },
  {
    key: "direct_expense",
    title: "Less: purchases and direct expenses",
    nature: "expense",
    gp: true,
  },
  { key: "indirect_income", title: "Add: indirect incomes", nature: "income", gp: false },
  { key: "indirect_expense", title: "Less: indirect expenses", nature: "expense", gp: false },
];

export type ProfitAndLoss = {
  /** value column keys in order (without Total / Change) */
  columns: string[];
  headers: string[];
  sections: Record<PlSectionKey, number[]>;
  grossProfit: number[];
  netProfit: number[];
  table: ReportTable;
};

/**
 * Build the statement. `extra`: "total" adds a Total column (dimension columns), "change" adds Change and Change %
 * (a comparison: the columns must be ["cur", "cmp"]).
 */
export function buildProfitAndLoss(
  accounts: readonly StatementAccount[],
  data: PlData,
  opts: {
    extra?: "total" | "change" | null;
    hrefFor?: (a: StatementAccount) => string | null;
    groupsOnly?: boolean;
  } = {},
): ProfitAndLoss {
  const cols = data.columns;
  const width = cols.length;
  const idx = new Map(cols.map((c, i) => [c, i]));
  const values = new Map<string, number[]>();
  for (const r of data.rows) {
    const i = idx.get(r.col);
    if (i === undefined) continue;
    const v = values.get(r.account_id) ?? new Array<number>(width).fill(0);
    v[i] += cents(r.amount);
    values.set(r.account_id, v);
  }
  const roots = accounts.filter((a) => !a.parent_id);
  const rows: ReportRow[] = [];
  const sectionTotals = {} as Record<PlSectionKey, number[]>;
  const extend = (v: number[]): Array<number | null> => {
    const base = v.map(fromCents);
    if (opts.extra === "total") return [...base, fromCents(v.reduce((s, x) => s + x, 0))];
    if (opts.extra === "change" && width === 2)
      return [...base, fromCents(v[0] - v[1]), pct(v[0] - v[1], Math.abs(v[1]))];
    return base;
  };
  const extendRow = (r: ReportRow): ReportRow => ({
    ...r,
    values: extend((r.values as number[]).map((x) => cents(x))),
  });
  const sub = (label: string, v: number[], kind: ReportRow["kind"]): ReportRow => ({
    label,
    depth: 0,
    kind,
    values: extend(v),
  });

  for (const s of PL_SECTIONS) {
    const sRoots = roots.filter(
      (r) => r.nature === s.nature && Boolean(r.affects_gross_profit) === s.gp,
    );
    const t = treeRows(accounts, values, width, {
      roots: sRoots,
      depth0: 1,
      hrefFor: opts.hrefFor,
      groupsOnly: opts.groupsOnly,
    });
    sectionTotals[s.key] = t.total;
    rows.push({ label: s.title, depth: 0, kind: "heading", values: [] });
    rows.push(...t.rows.map(extendRow));
    rows.push(
      sub(`Total ${s.title.replace(/^(Less|Add): /, "").toLowerCase()}`, t.total, "subtotal"),
    );
    if (s.key === "direct_expense") {
      const gp = sectionTotals.direct_income.map((x, i) => x - t.total[i]);
      rows.push(sub("Gross profit", gp, "total"));
    }
  }
  const gp = sectionTotals.direct_income.map((x, i) => x - sectionTotals.direct_expense[i]);
  const np = gp.map(
    (x, i) => x + sectionTotals.indirect_income[i] - sectionTotals.indirect_expense[i],
  );
  rows.push(sub("Net profit", np, "total"));
  const totalIncome = sectionTotals.direct_income.map(
    (x, i) => x + sectionTotals.indirect_income[i],
  );
  const margin = (num: number[], den: number[]): Array<number | null> => {
    const sum = (v: number[]) => v.reduce((s2, x) => s2 + x, 0);
    const base = num.map((x, i) => pct(x, den[i]));
    if (opts.extra === "total") return [...base, pct(sum(num), sum(den))];
    if (opts.extra === "change" && width === 2) return [...base, null, null];
    return base;
  };
  rows.push({
    label: "Gross margin",
    depth: 0,
    kind: "note",
    format: "percent",
    values: margin(gp, sectionTotals.direct_income),
  });
  rows.push({
    label: "Net margin",
    depth: 0,
    kind: "note",
    format: "percent",
    values: margin(np, totalIncome),
  });

  const headers = cols.map((c) => data.labels[c] ?? c);
  const allHeaders =
    opts.extra === "total"
      ? [...headers, "Total"]
      : opts.extra === "change" && width === 2
        ? [...headers, "Change", "Change %"]
        : headers;
  const formats = allHeaders.map((h) =>
    h === "Change %" ? ("percent" as const) : ("money" as const),
  );
  return {
    columns: cols,
    headers: allHeaders,
    sections: Object.fromEntries(
      Object.entries(sectionTotals).map(([k, v]) => [k, v.map(fromCents)]),
    ) as Record<PlSectionKey, number[]>,
    grossProfit: gp.map(fromCents),
    netProfit: np.map(fromCents),
    table: {
      labelHeader: "Account",
      columns: allHeaders,
      formats,
      rows,
      empty: "Nothing posted to income or expense accounts in this period.",
    },
  };
}
