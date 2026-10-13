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

export const ACCOUNTING_NAV: readonly AccountingNavEntry[] = [
  {
    href: "/accounting/dashboard",
    label: "Dashboard",
    section: "Overview",
    permissions: ["accounting.view"],
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
    href: "/accounting/periods",
    label: "Periods",
    section: "Close",
    permissions: ["accounting.periods.manage", "accounting.view"],
  },
  {
    href: "/accounting/entities",
    label: "Entities and fiscal years",
    section: "Setup",
    permissions: ["accounting.settings.manage", "accounting.view"],
  },
  {
    href: "/accounting/tax-codes",
    label: "Tax codes",
    section: "Setup",
    permissions: ["accounting.coa.manage", "accounting.tax.manage", "accounting.view"],
  },
  {
    href: "/accounting/cost-centres",
    label: "Cost centres",
    section: "Setup",
    permissions: ["accounting.coa.manage", "accounting.view"],
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

/** Where /accounting sends a member: the first entry they may open. */
export function accountingLanding(member: MemberLike): string | null {
  return accountingNavFor(member)[0]?.href ?? null;
}
