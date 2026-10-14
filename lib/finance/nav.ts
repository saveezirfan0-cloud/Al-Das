import { canAny, type MemberLike } from "@/lib/auth/can";

/**
 * The Finance section's own navigation, in one list so the layout, the landing redirect and the tests agree. Each entry is
 * visible to a member holding ANY of its permissions; the page checks again on its own. `badge` names a count the layout
 * fetches (only for members who can see the entry).
 */

export type FinanceBadge =
  "exceptions" | "preauth" | "denials" | "notReady" | "remittance" | "close" | "inbox";

export type FinanceNavEntry = {
  href: string;
  label: string;
  section: string;
  permissions: readonly string[];
  badge?: FinanceBadge;
  /** Extra words quick search matches (the label always matches). */
  keywords?: readonly string[];
};

const VOUCHERS = [
  "finance.payables.view",
  "finance.vouchers.prepare",
  "finance.vouchers.check",
  "finance.vouchers.approve_dept",
  "finance.vouchers.approve_ceo",
  "finance.vouchers.pay",
] as const;

const CLOSE = [
  "finance.close.view",
  "finance.close.manage",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
] as const;

export const FINANCE_NAV: readonly FinanceNavEntry[] = [
  {
    href: "/finance/summary",
    label: "Monthly summary",
    section: "Overview",
    permissions: ["finance.view"],
  },
  {
    href: "/finance/flash",
    label: "Daily flash",
    section: "Overview",
    permissions: ["finance.flash.view"],
  },
  {
    href: "/finance/revenue",
    label: "Revenue",
    section: "Overview",
    permissions: ["finance.revenue.view"],
  },
  {
    href: "/finance/scorecards",
    label: "Payer scorecards",
    section: "Overview",
    permissions: ["finance.scorecards.view"],
  },
  {
    href: "/finance/forecast",
    label: "Collections forecast",
    section: "Overview",
    permissions: ["finance.forecast.view"],
  },
  {
    href: "/finance/insurance",
    label: "Insurance overview",
    section: "Overview",
    permissions: ["finance.claims.view"],
  },
  {
    href: "/finance/receivables",
    label: "Receivables by age",
    section: "Overview",
    permissions: ["finance.claims.view"],
  },
  {
    href: "/finance/branches",
    label: "Branches",
    section: "Overview",
    permissions: ["finance.view"],
  },
  {
    href: "/finance/doctors",
    label: "Doctors",
    section: "Overview",
    permissions: ["finance.revenue.view"],
  },
  {
    href: "/finance/doctor-performance",
    label: "Doctor performance",
    section: "Overview",
    permissions: ["finance.revenue.view"],
    keywords: [
      "arpp",
      "revenue per patient",
      "doctor comparison",
      "month comparison",
      "revenue comparison",
      "target bands",
      "unite report",
    ],
  },
  {
    href: "/finance/collections",
    label: "Collections and data quality",
    section: "Overview",
    permissions: ["finance.revenue.view"],
    keywords: [
      "payment modes",
      "cash card",
      "self-pay insurance",
      "late invoices",
      "data quality",
      "unite report",
    ],
  },
  {
    href: "/finance/analytics",
    label: "Billing mix and trends",
    section: "Overview",
    permissions: ["finance.revenue.view"],
  },
  {
    href: "/finance/profitability",
    label: "Profitability",
    section: "Overview",
    permissions: ["finance.profit.view"],
  },
  {
    href: "/finance/invoices",
    label: "Invoices",
    section: "Billing and claims",
    permissions: ["finance.invoices.view"],
  },
  {
    href: "/finance/claims",
    label: "Claims",
    section: "Billing and claims",
    permissions: ["finance.claims.view"],
  },
  {
    href: "/finance/insurance-billing",
    label: "Billed vs claimed",
    section: "Billing and claims",
    permissions: ["finance.claims.view"],
    keywords: [
      "insurance billing",
      "billed not submitted",
      "unsubmitted claims",
      "claim reconciliation",
      "diligence vs unite",
      "money at risk",
    ],
  },
  {
    href: "/finance/upload",
    label: "Uploads (insurance, Unite)",
    section: "Billing and claims",
    permissions: ["finance.claims.import", "finance.revenue.import"],
  },
  {
    href: "/finance/eligibility",
    label: "Eligibility",
    section: "Billing and claims",
    permissions: ["finance.eligibility.manage"],
    badge: "notReady",
  },
  {
    href: "/finance/preauth",
    label: "Pre-authorisations",
    section: "Billing and claims",
    permissions: ["finance.preauth.manage"],
    badge: "preauth",
  },
  {
    href: "/finance/denials",
    label: "Denials",
    section: "Billing and claims",
    permissions: ["finance.denials.manage"],
    badge: "denials",
  },
  {
    href: "/finance/remittance",
    label: "Remittance",
    section: "Billing and claims",
    permissions: ["finance.remittance.manage"],
    badge: "remittance",
  },
  {
    href: "/finance/followup",
    label: "Insurance follow-up",
    section: "Billing and claims",
    permissions: ["finance.claims.view"],
  },
  {
    href: "/finance/invoice-changes",
    label: "Invoice changes",
    section: "Billing and claims",
    permissions: ["finance.changes.view"],
  },
  {
    href: "/finance/exceptions",
    label: "Exceptions",
    section: "Billing and claims",
    permissions: ["finance.exceptions.manage"],
    badge: "exceptions",
  },
  {
    href: "/finance/cashup",
    label: "Cash-up",
    section: "Money",
    permissions: ["finance.cashup.manage"],
  },
  {
    href: "/finance/recovery",
    label: "Self-pay reminders",
    section: "Money",
    permissions: ["finance.recovery.manage", "finance.recovery.approve"],
  },
  {
    href: "/finance/payment-links",
    label: "Payment links",
    section: "Money",
    permissions: ["finance.payment_links"],
  },
  {
    href: "/finance/vouchers",
    label: "Payment vouchers",
    section: "Money",
    permissions: VOUCHERS,
  },
  {
    href: "/finance/vouchers/report",
    label: "Voucher report",
    section: "Money",
    permissions: VOUCHERS,
  },
  {
    href: "/finance/inbox",
    label: "Finance inbox",
    section: "Money",
    permissions: ["finance.inbox.manage"],
    badge: "inbox",
  },
  {
    href: "/finance/payables",
    label: "Supplier invoices",
    section: "Money",
    permissions: ["finance.payables.view", "finance.payables.manage"],
  },
  {
    href: "/finance/suppliers",
    label: "Suppliers",
    section: "Money",
    permissions: ["finance.payables.view", "finance.payables.manage"],
  },
  {
    href: "/finance/tally",
    label: "Tally export",
    section: "Money",
    permissions: ["finance.tally.export"],
  },
  {
    href: "/finance/bank",
    label: "Bank reconciliation",
    section: "Money",
    permissions: ["finance.bank.view"],
  },
  {
    href: "/finance/labs",
    label: "Labs and referrals",
    section: "Money",
    permissions: ["finance.labs.view"],
  },
  {
    href: "/finance/close",
    label: "Month-end close",
    section: "Money",
    permissions: CLOSE,
    badge: "close",
  },
  {
    href: "/finance/close/timetable",
    label: "Close timetable",
    section: "Money",
    permissions: ["finance.close.view", "finance.close.manage", "finance.close.tasks"],
  },
  {
    href: "/finance/revenue-share",
    label: "Doctor revenue share",
    section: "Money",
    permissions: [
      "finance.revshare.view",
      "finance.revshare.manage",
      "finance.revshare.verify",
      "finance.revshare.approve",
    ],
  },
  {
    href: "/finance/export",
    label: "Accounting export",
    section: "Money",
    permissions: ["finance.export.run"],
  },
  {
    href: "/finance/costs",
    label: "Costs",
    section: "Money",
    permissions: ["finance.costs.manage", "finance.costs.view", "finance.costs.compensation"],
  },
  {
    href: "/finance/health",
    label: "Data health",
    section: "Setup",
    permissions: ["finance.capture.manage"],
  },
  {
    href: "/finance/reference",
    label: "Reference data",
    section: "Setup",
    permissions: ["finance.reference.manage"],
  },
  {
    href: "/finance/workflow-settings",
    label: "Workflow settings",
    section: "Setup",
    permissions: ["finance.reference.manage"],
  },
  {
    href: "/finance/flash/settings",
    label: "Targets and report lines",
    section: "Setup",
    permissions: ["finance.targets.manage"],
  },
  {
    href: "/finance/vouchers/settings",
    label: "Voucher settings",
    section: "Setup",
    permissions: ["finance.vouchers.settings", "finance.tally.export"],
  },
  {
    href: "/finance/bank/settings",
    label: "Bank accounts and rules",
    section: "Setup",
    permissions: ["finance.bank.manage"],
  },
  {
    href: "/finance/labs/settings",
    label: "Lab providers and tests",
    section: "Setup",
    permissions: ["finance.labs.manage"],
  },
];

export type NavBadges = Partial<Record<FinanceBadge, number>>;

/** The entries this member may see, with their badge counts. */
export function financeNavFor(
  member: MemberLike,
  badges: NavBadges = {},
): Array<{ href: string; label: string; section: string; badge?: number }> {
  return FINANCE_NAV.filter((e) => canAny(member, e.permissions)).map((e) => ({
    href: e.href,
    label: e.label,
    section: e.section,
    badge: e.badge ? (badges[e.badge] ?? 0) : undefined,
  }));
}

/** Where /finance sends a member: the first entry they may open. */
export function financeLanding(member: MemberLike): string | null {
  return financeNavFor(member)[0]?.href ?? null;
}

/** Which badges to fetch for this member (so a Billing user does not pay for the claims counts). */
export function badgesNeeded(member: MemberLike): FinanceBadge[] {
  return [
    ...new Set(
      FINANCE_NAV.filter((e) => e.badge && canAny(member, e.permissions)).map((e) => e.badge!),
    ),
  ];
}
