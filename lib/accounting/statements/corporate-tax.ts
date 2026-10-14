import {
  cents,
  fromCents,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";

/**
 * UAE corporate tax bridge, a WORKING PAPER (pure; never a tax return): accounting profit, add back the non-deductible
 * part of tagged expenses (entertainment at the configured percentage, fines and penalties, donations, other
 * non-deductible items), plus any adjustments typed on the page, = taxable income; tax at the configured rate above the
 * 0% band. Small Business Relief and the connected-person disclosure are notes, not decisions. Rates and thresholds come
 * from Settings (fin_ref_finance_settings), never from code.
 */

export const CT_TREATMENTS = [
  "entertainment",
  "fines_penalties",
  "donations",
  "non_deductible",
  "connected_person",
] as const;
export type CtTreatment = (typeof CT_TREATMENTS)[number];

export const CT_TREATMENT_LABELS: Record<CtTreatment, string> = {
  entertainment: "Entertainment (partly deductible)",
  fines_penalties: "Fines and penalties (not deductible)",
  donations: "Donations (not deductible unless to a qualifying body)",
  non_deductible: "Other non-deductible expense",
  connected_person: "Payments to connected persons (disclosure)",
};

export type CtSettings = {
  ct_rate: number;
  ct_threshold: number;
  ct_entertainment_pct: number;
  ct_sbr_limit: number;
  ct_connected_limit: number;
};

export type CtData = {
  from: string;
  to: string;
  provisional: boolean;
  settings: CtSettings;
  accounting_profit: number;
  revenue: number;
  by_treatment: Partial<Record<CtTreatment, number>>;
  accounts: Array<{
    account_id: string;
    code: string;
    name: string;
    treatment: CtTreatment;
    amount: number;
  }>;
};

export type CtManual = {
  /** other add-backs typed on the page (AED, >= 0) */
  otherAddBacks: number;
  /** other deductions typed on the page (AED, >= 0) */
  otherDeductions: number;
};

export type CtBridge = {
  accountingProfit: number;
  addBacks: number;
  taxableIncome: number;
  taxable: number;
  tax: number;
  sbrMayApply: boolean;
  connectedOverLimit: boolean;
  table: ReportTable;
  notes: string[];
};

export function ctBridge(d: CtData, manual: CtManual): CtBridge {
  const s = d.settings;
  const t = (k: CtTreatment) => cents(d.by_treatment[k] ?? 0);
  const ent = Math.round((t("entertainment") * Number(s.ct_entertainment_pct)) / 100);
  const fines = t("fines_penalties");
  const don = t("donations");
  const nd = t("non_deductible");
  const otherAdd = Math.max(0, cents(manual.otherAddBacks));
  const otherDed = Math.max(0, cents(manual.otherDeductions));
  const profit = cents(d.accounting_profit);
  const addBacks = ent + fines + don + nd + otherAdd;
  const taxableIncome = profit + addBacks - otherDed;
  const band = cents(s.ct_threshold);
  const taxable = Math.max(0, taxableIncome - band);
  const tax = Math.round((taxable * Number(s.ct_rate)) / 100);
  const revenue = cents(d.revenue);
  const sbrMayApply = revenue <= cents(s.ct_sbr_limit);
  const connected = t("connected_person");
  const connectedOverLimit = connected > cents(s.ct_connected_limit);
  const r = (
    label: string,
    c: number,
    kind: ReportRow["kind"] = "ledger",
    depth = 1,
  ): ReportRow => ({
    label,
    depth,
    kind,
    values: [fromCents(c)],
  });
  const rows: ReportRow[] = [
    r("Accounting profit (net profit for the period)", profit, "subtotal", 0),
    { label: "Add back: not deductible", depth: 0, kind: "heading", values: [] },
    r(
      `Entertainment: ${s.ct_entertainment_pct}% of ${fromCents(t("entertainment")).toLocaleString("en-GB")}`,
      ent,
    ),
    r("Fines and penalties", fines),
    r("Donations", don),
    r("Other non-deductible expense", nd),
    r("Other add-backs (typed on this page)", otherAdd),
    r("Total add-backs", addBacks, "subtotal", 0),
    r("Less: other deductions (typed on this page)", -otherDed, "ledger", 0),
    r("Taxable income", taxableIncome, "total", 0),
    r(
      `Less: 0% band up to AED ${Number(s.ct_threshold).toLocaleString("en-GB")}`,
      -Math.min(Math.max(taxableIncome, 0), band),
      "ledger",
      0,
    ),
    r(`Taxable at ${s.ct_rate}%`, taxable, "subtotal", 0),
    r("Corporate tax (estimate)", tax, "total", 0),
  ];
  const notes = [
    "Working paper, not a tax return: the tax adviser decides every adjustment and files through EmaraTax.",
    sbrMayApply
      ? `Revenue for the period (AED ${fromCents(revenue).toLocaleString("en-GB")}) is within the Small Business Relief limit (AED ${Number(s.ct_sbr_limit).toLocaleString("en-GB")}). Relief also needs revenue within the limit in every earlier tax period and an election on the return; with relief, taxable income is treated as nil.`
      : `Revenue for the period is above the Small Business Relief limit (AED ${Number(s.ct_sbr_limit).toLocaleString("en-GB")}), so the relief does not apply.`,
    connected > 0
      ? `Payments to connected persons in the period: AED ${fromCents(connected).toLocaleString("en-GB")}${connectedOverLimit ? `, above AED ${Number(s.ct_connected_limit).toLocaleString("en-GB")}: the transfer pricing disclosure form is likely needed` : ""}. They must be at market value; any excess is an add-back typed above.`
      : "No ledger is tagged as payments to connected persons.",
    "Not covered: the net interest cap, depreciation differences, losses brought forward, exempt income and qualifying group reliefs.",
  ];
  return {
    accountingProfit: fromCents(profit),
    addBacks: fromCents(addBacks),
    taxableIncome: fromCents(taxableIncome),
    taxable: fromCents(taxable),
    tax: fromCents(tax),
    sbrMayApply,
    connectedOverLimit,
    table: { labelHeader: "", columns: ["AED"], rows },
    notes,
  };
}

export function ctAccountsTable(
  d: CtData,
  hrefFor?: (accountId: string) => string | null,
): ReportTable {
  return {
    title: "Tagged ledgers",
    labelHeader: "Ledger",
    columns: ["Treatment", "Expense in the period"],
    formats: ["text", "money"],
    rows: d.accounts.map((a) => ({
      label: `${a.code} ${a.name}`,
      depth: 0,
      kind: "ledger",
      values: [CT_TREATMENT_LABELS[a.treatment] ?? a.treatment, Number(a.amount)],
      href: hrefFor ? hrefFor(a.account_id) : null,
    })),
    empty: "No ledger is tagged yet: tag them on the chart of accounts (Reporting).",
  };
}
