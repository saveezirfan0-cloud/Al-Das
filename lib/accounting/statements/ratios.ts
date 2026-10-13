import type { BsData } from "@/lib/accounting/statements/balance-sheet";
import type { PlData } from "@/lib/accounting/statements/profit-loss";
import {
  cents,
  daysIn,
  fromCents,
  pct,
  ratio,
  type ReportTable,
} from "@/lib/accounting/statements/report";
import { systemAncestors, under, type StatementAccount } from "@/lib/accounting/statements/tree";

/**
 * Ratio analysis (pure) from the balance sheet at the end of a period and the P&L for it. Groups are found by Tally's
 * system groups: current assets (Current Assets), current liabilities (Current Liabilities and Bank OD), stock
 * (Stock-in-Hand), receivables (Sundry Debtors), payables (Sundry Creditors). Revenue per patient uses the patient
 * visit count from the finance analytics (counts only; no patient data reaches this page). A ratio whose denominator
 * is zero is shown as not available.
 */

export type RatioInputs = {
  currentAssets: number;
  currentLiabilities: number;
  stock: number;
  receivables: number;
  payables: number;
  directIncome: number;
  totalIncome: number;
  totalExpense: number;
  grossProfit: number;
  netProfit: number;
  days: number;
  patients: number | null;
};

export function ratioInputs(
  accounts: readonly StatementAccount[],
  bs: BsData,
  pl: PlData,
  patients: number | null,
): RatioInputs {
  const anc = systemAncestors(accounts);
  let ca = 0;
  let cl = 0;
  let stock = 0;
  let rec = 0;
  let pay = 0;
  for (const r of bs.rows) {
    const c = cents(r.balance);
    if (under(anc, r.account_id, "G-CA")) ca += c;
    if (under(anc, r.account_id, "G-CL") || under(anc, r.account_id, "G-BOD")) cl += c;
    if (under(anc, r.account_id, "G-STOCK")) stock += c;
    if (under(anc, r.account_id, "G-DEBT")) rec += c;
    if (under(anc, r.account_id, "G-CRED")) pay += c;
  }
  let di = 0;
  let ii = 0;
  let de = 0;
  let ie = 0;
  for (const t of pl.totals) {
    di += cents(t.direct_income);
    ii += cents(t.indirect_income);
    de += cents(t.direct_expense);
    ie += cents(t.indirect_expense);
  }
  return {
    currentAssets: fromCents(ca),
    currentLiabilities: fromCents(cl),
    stock: fromCents(stock),
    receivables: fromCents(rec),
    payables: fromCents(pay),
    directIncome: fromCents(di),
    totalIncome: fromCents(di + ii),
    totalExpense: fromCents(de + ie),
    grossProfit: fromCents(di - de),
    netProfit: fromCents(di + ii - de - ie),
    days: daysIn(pl.from, pl.to),
    patients,
  };
}

export type Ratios = {
  currentRatio: number | null;
  quickRatio: number | null;
  debtorDays: number | null;
  creditorDays: number | null;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  workingCapital: number;
  revenuePerPatient: number | null;
};

export function computeRatios(i: RatioInputs): Ratios {
  const days = (num: number, den: number) => {
    const r = ratio(num * i.days, den, 1);
    return r;
  };
  return {
    currentRatio: ratio(i.currentAssets, i.currentLiabilities),
    quickRatio: ratio(i.currentAssets - i.stock, i.currentLiabilities),
    debtorDays: days(i.receivables, i.totalIncome),
    creditorDays: days(i.payables, i.totalExpense),
    grossMarginPct: pct(i.grossProfit, i.directIncome),
    netMarginPct: pct(i.netProfit, i.totalIncome),
    workingCapital: fromCents(cents(i.currentAssets) - cents(i.currentLiabilities)),
    revenuePerPatient: i.patients && i.patients > 0 ? ratio(i.directIncome, i.patients) : null,
  };
}

export function ratiosTable(i: RatioInputs, r: Ratios): ReportTable {
  const row = (
    label: string,
    value: number | null,
    how: string,
    format: "ratio" | "percent" | "money" | "number",
  ) => ({
    label,
    depth: 0,
    kind: "ledger" as const,
    values: [value ?? "n/a", how],
    format,
  });
  return {
    labelHeader: "Ratio",
    columns: ["Value", "How it is worked out"],
    formats: ["ratio", "text"],
    rows: [
      row("Current ratio", r.currentRatio, "Current assets / current liabilities", "ratio"),
      row("Quick ratio", r.quickRatio, "(Current assets - stock) / current liabilities", "ratio"),
      row(
        "Working capital (AED)",
        r.workingCapital,
        "Current assets - current liabilities",
        "money",
      ),
      row("Debtor days", r.debtorDays, `Receivables / income x ${i.days} days`, "ratio"),
      row("Creditor days", r.creditorDays, `Payables / expenses x ${i.days} days`, "ratio"),
      row("Gross margin", r.grossMarginPct, "Gross profit / sales and direct incomes", "percent"),
      row("Net margin", r.netMarginPct, "Net profit / all income", "percent"),
      row(
        "Revenue per patient visit (AED)",
        r.revenuePerPatient,
        i.patients
          ? `Sales and direct incomes / ${i.patients} patient visits`
          : "No patient visit count for this period",
        "money",
      ),
    ],
  };
}

export function ratioInputsTable(i: RatioInputs): ReportTable {
  const row = (label: string, v: number) => ({
    label,
    depth: 0,
    kind: "ledger" as const,
    values: [v],
  });
  return {
    title: "Figures used",
    labelHeader: "Figure",
    columns: ["AED"],
    rows: [
      row("Current assets", i.currentAssets),
      row("Current liabilities", i.currentLiabilities),
      row("Stock", i.stock),
      row("Receivables (Sundry Debtors)", i.receivables),
      row("Payables (Sundry Creditors)", i.payables),
      row("Sales and direct incomes", i.directIncome),
      row("All income", i.totalIncome),
      row("All expenses", i.totalExpense),
      row("Gross profit", i.grossProfit),
      row("Net profit", i.netProfit),
    ],
  };
}
