import {
  cents,
  fromCents,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";
import type { StatementAccount } from "@/lib/accounting/statements/tree";

/**
 * Cash flow statement, indirect method (pure). Net profit, then each non-cash balance-sheet ledger's cash effect
 * (credit minus debit over the period) by class, reconciled to the cash and bank ledgers' own movement. The class of a
 * ledger is its own cash_flow_class, else the nearest group's, else the nearest Tally group's default below; cash and
 * bank control accounts are always cash. app.acc_cash_flow_classes() holds the same rules (a database test compares).
 */

export const CASH_FLOW_CLASSES = [
  "operating_noncash",
  "working_capital",
  "investing",
  "financing",
  "cash",
] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

export const CASH_FLOW_LABELS: Record<CashFlowClass, string> = {
  operating_noncash: "Non-cash item (added back)",
  working_capital: "Working capital",
  investing: "Investing",
  financing: "Financing",
  cash: "Cash and bank",
};

/** The default class of a Tally system group (app.acc_cf_default). */
export function cashFlowDefault(
  code: string,
  nature: string,
  isSystem: boolean,
): CashFlowClass | null {
  if (!isSystem) return null;
  if (["G-BANK", "G-CASH", "G-BOD"].includes(code)) return "cash";
  if (["G-FA", "G-INV"].includes(code)) return "investing";
  if (["G-CAP", "G-RES", "G-LOAN", "G-SECL", "G-UNSL"].includes(code)) return "financing";
  if (["G-PROV", "G-MISC"].includes(code)) return "operating_noncash";
  if (nature === "equity") return "financing";
  if (nature === "asset" || nature === "liability") return "working_capital";
  return null;
}

/** Every account's effective class (null for income and expense accounts). */
export function effectiveCashFlowClasses(
  accounts: readonly StatementAccount[],
): Map<string, CashFlowClass | null> {
  const byParent = new Map<string | null, StatementAccount[]>();
  for (const a of accounts) {
    const list = byParent.get(a.parent_id) ?? [];
    list.push(a);
    byParent.set(a.parent_id, list);
  }
  const out = new Map<string, CashFlowClass | null>();
  const walk = (parent: string | null, inherited: CashFlowClass | null, depth: number) => {
    if (depth > 64) return;
    for (const a of byParent.get(parent) ?? []) {
      const own =
        (a.cash_flow_class as CashFlowClass | null | undefined) ??
        cashFlowDefault(a.code, a.nature, a.is_system) ??
        inherited ??
        (a.nature === "equity" ? "financing" : "working_capital");
      out.set(
        a.id,
        a.nature === "income" || a.nature === "expense"
          ? null
          : a.control === "cash" || a.control === "bank"
            ? "cash"
            : own,
      );
      walk(a.id, own, depth + 1);
    }
  };
  walk(null, null, 0);
  return out;
}

export type CfData = {
  from: string;
  to: string;
  include_adjustment: boolean;
  provisional: boolean;
  net_profit: number;
  rows: Array<{ account_id: string; class: CashFlowClass; amount: number }>;
  cash_accounts: Array<{ account_id: string; opening: number; closing: number }>;
  totals: {
    net_profit: number;
    operating_noncash: number;
    working_capital: number;
    operating: number;
    investing: number;
    financing: number;
    net_change: number;
    opening_cash: number;
    closing_cash: number;
    cash_movement: number;
    difference: number;
  };
  classes: Record<string, string>;
};

export type CashFlow = {
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  openingCash: number;
  closingCash: number;
  difference: number;
  reconciles: boolean;
  tables: ReportTable[];
};

/** "Increase in Insurance receivable" / "Decrease in Supplier payables" for working capital; the name otherwise. */
export function effectLabel(
  name: string,
  nature: string | undefined,
  amount: number,
  cls: CashFlowClass,
): string {
  if (cls !== "working_capital") return name;
  const assetSide = nature === "asset";
  const increase = assetSide ? amount < 0 : amount > 0;
  return `${increase ? "Increase" : "Decrease"} in ${name}`;
}

export function buildCashFlow(
  accounts: readonly StatementAccount[],
  data: CfData,
  opts: { hrefFor?: (a: StatementAccount) => string | null } = {},
): CashFlow {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const name = (id: string) => byId.get(id)?.name ?? "Unknown account";
  const code = (id: string) => byId.get(id)?.code ?? null;
  const href = (id: string) => {
    const a = byId.get(id);
    return a && opts.hrefFor ? opts.hrefFor(a) : null;
  };
  const sumOf = (cls: CashFlowClass) =>
    data.rows.filter((r) => r.class === cls).reduce((s, r) => s + cents(r.amount), 0);
  const lines = (cls: CashFlowClass): ReportRow[] =>
    data.rows
      .filter((r) => r.class === cls)
      .sort((a, b) => ((code(a.account_id) ?? "") < (code(b.account_id) ?? "") ? -1 : 1))
      .map((r) => ({
        label: effectLabel(
          name(r.account_id),
          byId.get(r.account_id)?.nature,
          Number(r.amount),
          cls,
        ),
        code: code(r.account_id),
        depth: 1,
        kind: "ledger",
        values: [Number(r.amount)],
        href: href(r.account_id),
      }));
  const np = cents(data.net_profit);
  const noncash = sumOf("operating_noncash");
  const wc = sumOf("working_capital");
  const inv = sumOf("investing");
  const fin = sumOf("financing");
  const op = np + noncash + wc;
  const net = op + inv + fin;
  const openC = data.cash_accounts.reduce((s, r) => s + cents(r.opening), 0);
  const closeC = data.cash_accounts.reduce((s, r) => s + cents(r.closing), 0);
  const diff = net - (closeC - openC);
  const one = (label: string, c: number, kind: ReportRow["kind"], depth = 0): ReportRow => ({
    label,
    depth,
    kind,
    values: [fromCents(c)],
  });
  const rows: ReportRow[] = [
    { label: "Operating activities", depth: 0, kind: "heading", values: [] },
    one("Net profit for the period", np, "ledger", 1),
    {
      label: "Adjustments for non-cash items",
      depth: 1,
      kind: "group",
      values: [fromCents(noncash)],
    },
    ...lines("operating_noncash").map((r) => ({ ...r, depth: 2 })),
    { label: "Changes in working capital", depth: 1, kind: "group", values: [fromCents(wc)] },
    ...lines("working_capital").map((r) => ({ ...r, depth: 2 })),
    one("Net cash from operating activities", op, "subtotal"),
    { label: "Investing activities", depth: 0, kind: "heading", values: [] },
    ...lines("investing"),
    one("Net cash from investing activities", inv, "subtotal"),
    { label: "Financing activities", depth: 0, kind: "heading", values: [] },
    ...lines("financing"),
    one("Net cash from financing activities", fin, "subtotal"),
    one("Net change in cash and bank", net, "total"),
    one("Cash and bank at the start", openC, "ledger"),
    one("Cash and bank at the end", openC + net, "total"),
  ];
  const recon: ReportRow[] = [
    ...data.cash_accounts
      .slice()
      .sort((a, b) => ((code(a.account_id) ?? "") < (code(b.account_id) ?? "") ? -1 : 1))
      .map((r): ReportRow => ({
        label: name(r.account_id),
        code: code(r.account_id),
        depth: 1,
        kind: "ledger",
        values: [
          Number(r.opening),
          Number(r.closing),
          fromCents(cents(r.closing) - cents(r.opening)),
        ],
        href: href(r.account_id),
      })),
    {
      label: "Cash and bank ledgers",
      depth: 0,
      kind: "total",
      values: [fromCents(openC), fromCents(closeC), fromCents(closeC - openC)],
    },
    {
      label: "Difference from the statement",
      depth: 0,
      kind: "total",
      values: [null, null, fromCents(diff)],
      flag: diff === 0 ? null : "warning",
    },
  ];
  return {
    operating: fromCents(op),
    investing: fromCents(inv),
    financing: fromCents(fin),
    netChange: fromCents(net),
    openingCash: fromCents(openC),
    closingCash: fromCents(closeC),
    difference: fromCents(diff),
    reconciles: diff === 0,
    tables: [
      { labelHeader: "", columns: ["AED"], rows, empty: "Nothing posted in this period." },
      {
        title: "Reconciliation to the cash and bank ledgers",
        labelHeader: "Ledger",
        columns: ["Opening", "Closing", "Movement"],
        rows: recon,
      },
    ],
  };
}
