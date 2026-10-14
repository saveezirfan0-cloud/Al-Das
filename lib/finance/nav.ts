import { canAny, type MemberLike } from "@/lib/auth/can";
import { HUB_NAV_PERMISSIONS } from "@/lib/finance/reports-hub";

/**
 * The Finance section's own navigation, in one list so the layout, the landing redirect and the tests agree. Each entry is
 * visible to a member holding ANY of its permissions; the page checks again on its own. `badge` names a count the layout
 * fetches (only for members who can see the entry).
 */

export type FinanceBadge =
  "exceptions" | "preauth" | "denials" | "notReady" | "remittance" | "close" | "inbox";

/** A sibling page shown as a tab under one menu entry (see `tabs`). */
export type FinanceTab = { href: string; label: string; permissions: readonly string[] };

export type FinanceNavEntry = {
  href: string;
  label: string;
  section: string;
  permissions: readonly string[];
  badge?: FinanceBadge;
  /**
   * Phase D: sibling pages shown as tabs under this one entry (components/shell/module-tabs.tsx). The entry opens the
   * first tab the member may open; `href` is the first tab's and `permissions` the union. A badge belongs to the first
   * tab and is fetched only for members who can open that tab.
   */
  tabs?: readonly FinanceTab[];
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

/** One menu entry for a group of sibling pages: it opens the first tab the member may open. */
function tabGroup(
  label: string,
  section: string,
  tabs: readonly FinanceTab[],
  badge?: FinanceBadge,
): FinanceNavEntry {
  return {
    href: tabs[0].href,
    label,
    section,
    permissions: [...new Set(tabs.flatMap((t) => t.permissions))],
    ...(badge ? { badge } : {}),
    tabs,
  };
}

/**
 * The Finance menu (Phase D: from 44 entries to 21). Sibling overview pages are tabs under one entry; setup pages live
 * under Settings (`FINANCE_SETUP_PAGES`, same URLs). Sections follow docs/34 §3.
 */
export const FINANCE_NAV: readonly FinanceNavEntry[] = [
  {
    // Phase G: every report in one place (the page shows each card to holders of that report's own key)
    href: "/finance/reports",
    label: "Reports hub",
    section: "Reports",
    permissions: HUB_NAV_PERMISSIONS,
  },
  tabGroup("Performance", "Reports", [
    { href: "/finance/summary", label: "Monthly summary", permissions: ["finance.view"] },
    { href: "/finance/flash", label: "Daily flash", permissions: ["finance.flash.view"] },
    { href: "/finance/revenue", label: "Revenue", permissions: ["finance.revenue.view"] },
    { href: "/finance/branches", label: "By branch", permissions: ["finance.view"] },
    { href: "/finance/doctors", label: "By doctor", permissions: ["finance.revenue.view"] },
    {
      href: "/finance/analytics",
      label: "Billing mix and trends",
      permissions: ["finance.revenue.view"],
    },
    {
      href: "/finance/profitability",
      label: "Profitability",
      permissions: ["finance.profit.view"],
    },
  ]),
  tabGroup("Insurance and receivables", "Reports", [
    { href: "/finance/insurance", label: "Overview", permissions: ["finance.claims.view"] },
    {
      href: "/finance/receivables",
      label: "By payer and age",
      permissions: ["finance.claims.view"],
    },
    {
      href: "/finance/scorecards",
      label: "Payer scorecards",
      permissions: ["finance.scorecards.view"],
    },
    {
      href: "/finance/forecast",
      label: "Collections forecast",
      permissions: ["finance.forecast.view"],
    },
  ]),
  {
    href: "/finance/invoices",
    label: "Invoices",
    section: "Claims & collections",
    permissions: ["finance.invoices.view"],
  },
  tabGroup("Claims", "Claims & collections", [
    { href: "/finance/claims", label: "Claims", permissions: ["finance.claims.view"] },
    { href: "/finance/upload", label: "Insurance upload", permissions: ["finance.claims.import"] },
    { href: "/finance/followup", label: "Follow-up", permissions: ["finance.claims.view"] },
  ]),
  {
    href: "/finance/eligibility",
    label: "Eligibility",
    section: "Claims & collections",
    permissions: ["finance.eligibility.manage"],
    badge: "notReady",
  },
  {
    href: "/finance/preauth",
    label: "Pre-authorisations",
    section: "Claims & collections",
    permissions: ["finance.preauth.manage"],
    badge: "preauth",
  },
  {
    href: "/finance/denials",
    label: "Denials",
    section: "Claims & collections",
    permissions: ["finance.denials.manage"],
    badge: "denials",
  },
  {
    href: "/finance/remittance",
    label: "Remittance",
    section: "Claims & collections",
    permissions: ["finance.remittance.manage"],
    badge: "remittance",
  },
  {
    href: "/finance/exceptions",
    label: "Exceptions",
    section: "Claims & collections",
    permissions: ["finance.exceptions.manage"],
    badge: "exceptions",
  },
  {
    href: "/finance/invoice-changes",
    label: "Invoice changes",
    section: "Claims & collections",
    permissions: ["finance.changes.view"],
  },
  tabGroup("Patient payments", "Claims & collections", [
    {
      href: "/finance/recovery",
      label: "Self-pay reminders",
      permissions: ["finance.recovery.manage", "finance.recovery.approve"],
    },
    {
      href: "/finance/payment-links",
      label: "Payment links",
      permissions: ["finance.payment_links"],
    },
  ]),
  {
    href: "/finance/cashup",
    label: "Cash-up",
    section: "Money",
    permissions: ["finance.cashup.manage"],
  },
  {
    href: "/finance/inbox",
    label: "Finance inbox",
    section: "Money",
    permissions: ["finance.inbox.manage"],
    badge: "inbox",
  },
  tabGroup("Payables", "Money", [
    {
      href: "/finance/payables",
      label: "Supplier invoices",
      permissions: ["finance.payables.view", "finance.payables.manage"],
    },
    { href: "/finance/vouchers", label: "Payment vouchers", permissions: VOUCHERS },
    { href: "/finance/vouchers/report", label: "Voucher report", permissions: VOUCHERS },
    {
      href: "/finance/suppliers",
      label: "Suppliers",
      permissions: ["finance.payables.view", "finance.payables.manage"],
    },
  ]),
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
    href: "/finance/costs",
    label: "Costs",
    section: "Money",
    permissions: ["finance.costs.manage", "finance.costs.view", "finance.costs.compensation"],
  },
  tabGroup(
    "Month-end close",
    "Month-end",
    [
      { href: "/finance/close", label: "Close", permissions: CLOSE },
      {
        href: "/finance/close/timetable",
        label: "Timetable",
        permissions: ["finance.close.view", "finance.close.manage", "finance.close.tasks"],
      },
    ],
    "close",
  ),
  tabGroup("Exports", "Month-end", [
    { href: "/finance/tally", label: "Tally export", permissions: ["finance.tally.export"] },
    { href: "/finance/export", label: "Accounting export", permissions: ["finance.export.run"] },
  ]),
];

export type SetupPage = {
  href: string;
  label: string;
  permissions: readonly string[];
  keywords?: readonly string[];
};

/**
 * Finance setup pages (Phase D): listed under Settings, Finance setup (components/shell/settings-pages.ts). They keep
 * their URLs and the Finance layout, so the finance access window still applies. Each is gated by its own key.
 */
export const FINANCE_SETUP_PAGES: readonly SetupPage[] = [
  {
    href: "/finance/reference",
    label: "Finance reference data",
    permissions: ["finance.reference.manage"],
    keywords: ["payers", "insurers", "branch codes", "exception rules", "thresholds"],
  },
  {
    href: "/finance/workflow-settings",
    label: "Finance workflow settings",
    permissions: ["finance.reference.manage"],
    keywords: ["denial deadlines", "pre-authorisation expiry", "follow-up", "finance settings"],
  },
  {
    href: "/finance/flash/settings",
    label: "Flash targets and lines",
    permissions: ["finance.targets.manage"],
    keywords: ["daily targets", "flash", "arpp"],
  },
  {
    href: "/finance/vouchers/settings",
    label: "Voucher settings",
    permissions: ["finance.vouchers.settings", "finance.tally.export"],
    keywords: ["delegation of authority", "approval tiers", "tally ledgers", "voucher settings"],
  },
  {
    href: "/finance/bank/settings",
    label: "Bank reconciliation settings",
    permissions: ["finance.bank.manage"],
    keywords: ["statement formats", "matching rules", "card settlement"],
  },
  {
    href: "/finance/labs/settings",
    label: "Lab providers and tests",
    permissions: ["finance.labs.manage"],
    keywords: ["send-out lab", "referrals", "price list"],
  },
  {
    href: "/finance/health",
    label: "Finance data health",
    permissions: ["finance.capture.manage"],
    keywords: ["unite capture", "batches", "replay", "sync"],
  },
];

/** The entry's tabs this member may open, in order (empty for a plain entry). */
export function visibleFinanceTabs(e: FinanceNavEntry, member: MemberLike): FinanceTab[] {
  return (e.tabs ?? []).filter((t) => canAny(member, t.permissions));
}

function entryVisible(e: FinanceNavEntry, member: MemberLike): boolean {
  return e.tabs ? visibleFinanceTabs(e, member).length > 0 : canAny(member, e.permissions);
}

/** A tab group's badge belongs to its first tab: shown and fetched only for members who can open that tab. */
function badgeVisible(e: FinanceNavEntry, member: MemberLike): boolean {
  if (!e.badge) return false;
  return canAny(member, e.tabs ? e.tabs[0].permissions : e.permissions);
}

export type NavBadges = Partial<Record<FinanceBadge, number>>;

/** The entries this member may see, with their badge counts. A tab group opens its first visible tab. */
export function financeNavFor(
  member: MemberLike,
  badges: NavBadges = {},
): Array<{ href: string; label: string; section: string; badge?: number }> {
  return FINANCE_NAV.filter((e) => entryVisible(e, member)).map((e) => ({
    href: e.tabs ? visibleFinanceTabs(e, member)[0].href : e.href,
    label: e.label,
    section: e.section,
    badge: badgeVisible(e, member) ? (badges[e.badge!] ?? 0) : undefined,
  }));
}

/** Every Finance page this member reaches from a menu: plain entries, each visible tab, and the setup pages. */
export function financePagesFor(member: MemberLike): string[] {
  return [
    ...FINANCE_NAV.flatMap((e) =>
      e.tabs
        ? visibleFinanceTabs(e, member).map((t) => t.href)
        : entryVisible(e, member)
          ? [e.href]
          : [],
    ),
    ...FINANCE_SETUP_PAGES.filter((p) => canAny(member, p.permissions)).map((p) => p.href),
  ];
}

/** The tab groups this member sees with two or more tabs (the tab strip on those pages). Plain data. */
export function financeTabGroupsFor(
  member: MemberLike,
): Array<{ label: string; tabs: Array<{ href: string; label: string }> }> {
  return FINANCE_NAV.filter((e) => e.tabs)
    .map((e) => ({
      label: e.label,
      tabs: visibleFinanceTabs(e, member).map((t) => ({ href: t.href, label: t.label })),
    }))
    .filter((g) => g.tabs.length > 1);
}

/**
 * Where /finance sends a member: the first entry they may open. There is no finance work-queue page yet, so holders of
 * a report key land on the Reports hub (Phase G); others on their first page.
 */
export function financeLanding(member: MemberLike): string | null {
  return financeNavFor(member)[0]?.href ?? null;
}

/** Which badges to fetch for this member (so a Billing user does not pay for the claims counts). */
export function badgesNeeded(member: MemberLike): FinanceBadge[] {
  return [...new Set(FINANCE_NAV.filter((e) => badgeVisible(e, member)).map((e) => e.badge!))];
}
