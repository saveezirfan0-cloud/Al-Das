import { canAny, type MemberLike } from "@/lib/auth/can";

/**
 * The Accounting module's own navigation (docs/22_ACCOUNTING_PLAN.md §5), in one list so the layout, the landing
 * redirect and the tests agree. Same shape as FINANCE_NAV. Each entry is visible to a member holding ANY of its
 * permissions; the page checks again. Only pages that exist are listed; later slices add theirs.
 */

export type AccountingNavEntry = {
  href: string;
  label: string;
  section: string;
  permissions: readonly string[];
};

/** Fixed assets, depreciation and schedules (22H): managers, the approvers who post runs, and readers. */
const ASSETS = [
  "accounting.assets.manage",
  "accounting.journals.approve",
  "accounting.reports.view",
  "accounting.view",
] as const;

const JOURNALS = [
  "accounting.ledger.view",
  "accounting.journals.prepare",
  "accounting.journals.approve",
] as const;

/** Who reads receivables (mirrors app.acc_can_read_receivables in migration 20261109000200). */
export const RECEIVABLES_READ = [
  "accounting.sales.manage",
  "accounting.receipts.manage",
  "accounting.ledger.view",
  "accounting.reports.view",
  "accounting.journals.approve",
] as const;

/**
 * Who reads payables (Phase G: payables ageing and supplier statements over the 20D supplier invoices and vouchers):
 * the ledger and report readers and the checker. Read-only reports, so no new key.
 */
export const PAYABLES_READ = [
  "accounting.reports.view",
  "accounting.ledger.view",
  "accounting.journals.approve",
] as const;

/** Banking pages (22F): kept by accounting.banking.manage, read by ledger readers and checkers. */
const BANKING = [
  "accounting.banking.manage",
  "accounting.ledger.view",
  "accounting.journals.approve",
] as const;

export const ACCOUNTING_NAV: readonly AccountingNavEntry[] = [
  {
    href: "/accounting/dashboard",
    label: "Dashboard",
    section: "Overview",
    permissions: ["accounting.view"],
  },
  {
    href: "/accounting/waiting",
    label: "Waiting to post",
    section: "Overview",
    permissions: ["accounting.ledger.view", "accounting.journals.approve"],
  },
  {
    href: "/accounting/accounts",
    label: "Chart of accounts",
    section: "Ledger",
    permissions: ["accounting.view", "accounting.coa.manage"],
  },
  { href: "/accounting/journals", label: "Journals", section: "Ledger", permissions: JOURNALS },
  {
    href: "/accounting/day-book",
    label: "Day book",
    section: "Ledger",
    permissions: ["accounting.ledger.view"],
  },
  {
    href: "/accounting/ledger",
    label: "General ledger",
    section: "Ledger",
    permissions: ["accounting.ledger.view"],
  },
  {
    href: "/accounting/sales-invoices",
    label: "Sales invoices",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/credit-notes",
    label: "Credit notes",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/receipts",
    label: "Receipts",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/customers",
    label: "Customers",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/receivables-ageing",
    label: "Receivables ageing",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/statements",
    label: "Statements",
    section: "Sales & receivables",
    permissions: RECEIVABLES_READ,
  },
  {
    href: "/accounting/payables-ageing",
    label: "Payables ageing",
    section: "Purchases & payables",
    permissions: PAYABLES_READ,
  },
  {
    href: "/accounting/supplier-statements",
    label: "Supplier statements",
    section: "Purchases & payables",
    permissions: PAYABLES_READ,
  },
  {
    href: "/accounting/banking",
    label: "Bank accounts",
    section: "Banking",
    permissions: BANKING,
  },
  {
    href: "/accounting/banking/transfers",
    label: "Transfers",
    section: "Banking",
    permissions: BANKING,
  },
  {
    href: "/accounting/banking/entries",
    label: "Bank entries",
    section: "Banking",
    permissions: BANKING,
  },
  {
    href: "/accounting/banking/petty-cash",
    label: "Petty cash",
    section: "Banking",
    permissions: BANKING,
  },
  {
    href: "/accounting/banking/cheques",
    label: "Cheques",
    section: "Banking",
    permissions: BANKING,
  },
  // Assets after Banking, as plan §5 lists the sections (22K: the merge had put them after Ledger)
  { href: "/accounting/assets", label: "Fixed assets", section: "Assets", permissions: ASSETS },
  {
    href: "/accounting/depreciation",
    label: "Depreciation",
    section: "Assets",
    permissions: ASSETS,
  },
  { href: "/accounting/schedules", label: "Schedules", section: "Assets", permissions: ASSETS },
  {
    href: "/accounting/trial-balance",
    label: "Trial balance",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/posting-preview",
    label: "Posting preview",
    section: "Reports",
    permissions: ["accounting.reports.view", "accounting.ledger.view"],
  },
  {
    href: "/accounting/reports/profit-and-loss",
    label: "Profit and loss",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/reports/balance-sheet",
    label: "Balance sheet",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/reports/cash-flow",
    label: "Cash flow",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/budgets",
    label: "Budgets",
    section: "Reports",
    permissions: [
      "accounting.budgets.manage",
      "accounting.journals.approve",
      "accounting.reports.view",
    ],
  },
  {
    href: "/accounting/reports/budget-vs-actual",
    label: "Budget against actual",
    section: "Reports",
    permissions: [
      "accounting.reports.view",
      "accounting.budgets.manage",
      "accounting.journals.approve",
    ],
  },
  {
    href: "/accounting/reports/vat-return",
    label: "VAT return",
    section: "Reports",
    permissions: ["accounting.reports.view", "accounting.tax.manage"],
  },
  {
    href: "/accounting/reports/ratios",
    label: "Ratios",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/reports/exceptions",
    label: "Ledger exceptions",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/reports/corporate-tax",
    label: "Corporate tax bridge",
    section: "Reports",
    permissions: ["accounting.reports.view"],
  },
  {
    href: "/accounting/periods",
    label: "Periods",
    section: "Close",
    permissions: ["accounting.periods.manage", "accounting.view"],
  },
  {
    href: "/accounting/year-end",
    label: "Year-end close",
    section: "Close",
    permissions: ["accounting.periods.manage", "accounting.view"],
  },
];

/**
 * Accounting setup pages (Phase D): listed under Settings, Accounting setup (components/shell/settings-pages.ts). They
 * keep their URLs and the Accounting layout (finance access window). Each is gated by its own keys.
 */
export const ACCOUNTING_SETUP_PAGES: ReadonlyArray<Omit<AccountingNavEntry, "section">> = [
  {
    href: "/accounting/entities",
    label: "Entities and fiscal years",
    permissions: ["accounting.settings.manage", "accounting.view"],
  },
  {
    href: "/accounting/tax-codes",
    label: "Tax codes",
    permissions: ["accounting.coa.manage", "accounting.tax.manage", "accounting.view"],
  },
  {
    href: "/accounting/receivables-settings",
    label: "Sales settings",
    permissions: ["accounting.settings.manage"],
  },
  {
    href: "/accounting/cost-centres",
    label: "Cost centres",
    permissions: ["accounting.coa.manage", "accounting.view"],
  },
  {
    href: "/accounting/posting-rules",
    label: "Posting rules",
    permissions: ["accounting.settings.manage", "accounting.view"],
  },
  {
    href: "/accounting/report-settings",
    label: "Report settings",
    permissions: ["accounting.settings.manage", "accounting.reports.view"],
  },
  {
    href: "/accounting/tally-import",
    label: "Tally import",
    permissions: ["accounting.import"],
  },
  {
    href: "/accounting/opening-balances",
    label: "Opening balances",
    permissions: ["accounting.import"],
  },
  {
    href: "/accounting/tally-reconciliation",
    label: "Tally reconciliation",
    permissions: ["accounting.import"],
  },
  {
    href: "/accounting/tally-bridge",
    label: "Tally bridge",
    permissions: ["accounting.import"],
  },
];

/** Every accounting.* key: holding any of them shows the Accounting item in the sidebar. */
export const ACCOUNTING_KEYS = [
  "accounting.view",
  "accounting.ledger.view",
  "accounting.reports.view",
  "accounting.coa.manage",
  "accounting.journals.prepare",
  "accounting.journals.approve",
  "accounting.sales.manage",
  "accounting.receipts.manage",
  "accounting.banking.manage",
  "accounting.assets.manage",
  "accounting.budgets.manage",
  "accounting.periods.manage",
  "accounting.tax.manage",
  "accounting.settings.manage",
  "accounting.import",
] as const;

export function accountingNavFor(
  member: MemberLike,
): Array<{ href: string; label: string; section: string }> {
  return ACCOUNTING_NAV.filter((e) => canAny(member, e.permissions)).map((e) => ({
    href: e.href,
    label: e.label,
    section: e.section,
  }));
}

/** Every Accounting page this member reaches from a menu: the module's entries and the setup pages under Settings. */
export function accountingPagesFor(member: MemberLike): string[] {
  return [...ACCOUNTING_NAV, ...ACCOUNTING_SETUP_PAGES]
    .filter((e) => canAny(member, e.permissions))
    .map((e) => e.href);
}

/** Where /accounting sends a member: the first entry they may open. */
export function accountingLanding(member: MemberLike): string | null {
  return accountingNavFor(member)[0]?.href ?? null;
}
