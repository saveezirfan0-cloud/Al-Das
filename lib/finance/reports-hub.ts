import { canAny, type MemberLike } from "@/lib/auth/can";
import { canSeeLocation, type BranchAccess } from "@/lib/branches/access";

/**
 * The finance reports hub (Phase G, pure): one page of report cards with a shared branch, period and comparison picker.
 * Each card is shown only to members holding the report's own permission (the same key its page checks), and its links
 * carry ONLY the query parameters that page (or its export route) already reads, so a link never asks a page for
 * something it would ignore. What a card does not use is listed on the card instead.
 */

export const PERIOD_KINDS = ["month", "quarter", "year"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export type HubPicker = {
  /** A finance branch code (fin_ref_branches.code), or null for all branches. */
  branch: string | null;
  kind: PeriodKind;
  /** yyyy-mm, yyyy-Qn or yyyy. */
  key: string;
  compare: boolean;
};

export type HubRange = {
  from: string;
  to: string;
  fromMonth: string;
  toMonth: string;
  label: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The first and last day of a month, quarter or year, or null for a key that is not one. */
export function periodRange(kind: PeriodKind, key: string): HubRange | null {
  let y: number;
  let m1: number;
  let m2: number;
  let label: string;
  if (kind === "month") {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
    if (!m) return null;
    y = Number(m[1]);
    m1 = m2 = Number(m[2]);
    label = `${MONTHS[m1 - 1]} ${y}`;
  } else if (kind === "quarter") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) return null;
    y = Number(m[1]);
    m1 = (Number(m[2]) - 1) * 3 + 1;
    m2 = m1 + 2;
    label = `Q${m[2]} ${y} (${MONTHS[m1 - 1].slice(0, 3)} to ${MONTHS[m2 - 1].slice(0, 3)})`;
  } else {
    const m = /^(\d{4})$/.exec(key);
    if (!m) return null;
    y = Number(m[1]);
    m1 = 1;
    m2 = 12;
    label = `${y}`;
  }
  if (y < 2000 || y > 2999) return null;
  return {
    from: `${y}-${pad(m1)}-01`,
    to: `${y}-${pad(m2)}-${pad(lastDay(y, m2))}`,
    fromMonth: `${y}-${pad(m1)}`,
    toMonth: `${y}-${pad(m2)}`,
    label,
  };
}

/** The period that contains `today` (yyyy-mm-dd). */
export function currentKey(kind: PeriodKind, today: string): string {
  const y = today.slice(0, 4);
  const m = Number(today.slice(5, 7));
  if (kind === "month") return today.slice(0, 7);
  if (kind === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return y;
}

/** The period before `key`. */
export function previousKey(kind: PeriodKind, key: string): string {
  if (kind === "year") return String(Number(key) - 1);
  if (kind === "quarter") {
    const y = Number(key.slice(0, 4));
    const q = Number(key.slice(6));
    return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
  }
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The current period and the `count - 1` before it, newest first, for the picker. */
export function periodOptions(
  kind: PeriodKind,
  today: string,
  count: number,
): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  let key = currentKey(kind, today);
  for (let i = 0; i < count; i++) {
    out.push({ key, label: periodRange(kind, key)!.label });
    key = previousKey(kind, key);
  }
  return out;
}

export const PERIOD_OPTION_COUNT: Record<PeriodKind, number> = { month: 24, quarter: 12, year: 5 };

/**
 * The picker from the hub's own query string. The period must be one the picker offers (not in the future, not older
 * than its list); the branch must be one of `branchCodes` (the codes this member may pick), else the default.
 */
export function parseHubParams(
  sp: Record<string, string | string[] | undefined>,
  today: string,
  branchCodes: readonly string[],
  defaultBranch: string | null,
): HubPicker {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const kind = (PERIOD_KINDS as readonly string[]).includes(one(sp.period))
    ? (one(sp.period) as PeriodKind)
    : "month";
  const offered = periodOptions(kind, today, PERIOD_OPTION_COUNT[kind]).map((o) => o.key);
  const key = offered.includes(one(sp.key)) ? one(sp.key) : offered[0];
  const rawBranch = one(sp.branch);
  const branch =
    rawBranch === "all"
      ? null
      : branchCodes.includes(rawBranch)
        ? rawBranch
        : defaultBranch && branchCodes.includes(defaultBranch)
          ? defaultBranch
          : null;
  return { branch, kind, key, compare: one(sp.compare) === "1" };
}

/** The finance branches this member may pick, and the one the hub opens on (the branch switcher's, when it has a code). */
export function hubBranches(
  finBranches: ReadonlyArray<{ code: string; name: string }>,
  locations: ReadonlyArray<{ id: string; branch_code: string | null }>,
  access: BranchAccess,
  currentLocationId: string | null,
): { options: Array<{ code: string; name: string }>; defaultCode: string | null } {
  const visibleCodes = new Set(
    locations
      .filter((l) => canSeeLocation(access, l.id) && l.branch_code)
      .map((l) => l.branch_code!.toUpperCase()),
  );
  const options =
    access.scope === "all"
      ? [...finBranches]
      : finBranches.filter((b) => visibleCodes.has(b.code.toUpperCase()));
  const current = locations.find((l) => l.id === currentLocationId)?.branch_code?.toUpperCase();
  const defaultCode = options.find((b) => b.code.toUpperCase() === current)?.code ?? null;
  return { options, defaultCode };
}

// ---- cards ---------------------------------------------------------------------------------------------------------

export const HUB_GROUPS = ["Management", "Accounting", "Receivables and RCM", "Tax"] as const;
export type HubGroup = (typeof HUB_GROUPS)[number];

export type HubContext = {
  picker: HubPicker;
  range: HubRange;
  /** The period's end, but never after today (a running month is month-to-date). */
  to: string;
  today: string;
  yesterday: string;
};

/** What a card takes from the picker (shown on the card, so nobody expects a filter a page does not have). */
export type HubUse = "period" | "day" | "as_of" | "branch" | "compare";

type Query = (c: HubContext) => Record<string, string | null | undefined>;

export type ReportCard = {
  key: string;
  group: HubGroup;
  title: string;
  description: string;
  href: string;
  permissions: readonly string[];
  uses: readonly HubUse[];
  query?: Query;
  exports?: ReadonlyArray<{ label: "Excel" | "CSV" | "PDF"; href: string; query?: Query }>;
  /** Phase G: the card can e-mail its report to the member (the same document as its Excel download). */
  email?: "daily_flash" | "monthly_summary";
};

const ACC_REPORTS = ["accounting.reports.view"] as const;
/** Receivables readers (mirrors RECEIVABLES_READ in lib/accounting/nav.ts; a test keeps them equal). */
const RECEIVABLES = [
  "accounting.sales.manage",
  "accounting.receipts.manage",
  "accounting.ledger.view",
  "accounting.reports.view",
  "accounting.journals.approve",
] as const;
/** Payables readers (PAYABLES_READ in lib/accounting/nav.ts). */
const PAYABLES = [
  "accounting.reports.view",
  "accounting.ledger.view",
  "accounting.journals.approve",
] as const;

const months: Query = (c) => ({ from: c.range.fromMonth, to: c.range.toMonth });
/** The flash shows one day: the period's last day, never after yesterday (today is not finished). */
const flashDay = (c: HubContext) => (c.to < c.yesterday ? c.to : c.yesterday);
const dates: Query = (c) => ({ from: c.range.from, to: c.to });
const statement =
  (compare: boolean): Query =>
  (c) => ({
    ...dates(c),
    ...(compare && c.picker.compare ? { compare: "previous" } : {}),
  });
const withFormat =
  (q: Query, format: "xlsx" | "pdf"): Query =>
  (c) => ({ format, ...q(c) });
const accountingExports = (report: string, q: Query) =>
  [
    {
      label: "Excel" as const,
      href: `/api/accounting/reports/${report}`,
      query: withFormat(q, "xlsx"),
    },
    {
      label: "PDF" as const,
      href: `/api/accounting/reports/${report}`,
      query: withFormat(q, "pdf"),
    },
  ] as const;

export const REPORT_CARDS: readonly ReportCard[] = [
  // Management
  {
    key: "flash",
    group: "Management",
    title: "Daily flash",
    description: "The day's revenue, visits and collections against target, with month to date.",
    href: "/finance/flash",
    permissions: ["finance.flash.view"],
    uses: ["day"],
    query: (c) => ({ date: flashDay(c) }),
    exports: [
      {
        label: "Excel",
        href: "/api/finance/flash",
        query: (c) => ({ date: flashDay(c) }),
      },
      {
        label: "PDF",
        href: "/api/finance/flash",
        query: (c) => ({ date: flashDay(c), format: "pdf" }),
      },
    ],
    email: "daily_flash",
  },
  {
    key: "summary",
    group: "Management",
    title: "Monthly summary",
    description:
      "Generated, claimed, collected and outstanding by month, compared with the period before.",
    href: "/finance/summary",
    permissions: ["finance.view"],
    uses: ["period", "branch"],
    query: (c) => ({ ...months(c), branch: c.picker.branch }),
    exports: [
      {
        label: "Excel",
        href: "/api/finance/summary",
        query: (c) => ({ format: "xlsx", ...months(c), branch: c.picker.branch }),
      },
      {
        label: "PDF",
        href: "/api/finance/summary",
        query: (c) => ({ format: "pdf", ...months(c), branch: c.picker.branch }),
      },
      {
        label: "CSV",
        href: "/api/finance/summary",
        query: (c) => ({ ...months(c), branch: c.picker.branch }),
      },
    ],
    email: "monthly_summary",
  },
  {
    key: "revenue",
    group: "Management",
    title: "Revenue",
    description: "Net revenue by service category, department, doctor or payer.",
    href: "/finance/revenue",
    permissions: ["finance.revenue.view"],
    uses: ["period", "branch", "compare"],
    query: (c) => ({
      ...dates(c),
      branch: c.picker.branch,
      compare: c.picker.compare ? "1" : null,
    }),
    exports: [
      {
        label: "CSV",
        href: "/api/finance/revenue",
        query: (c) => ({
          ...dates(c),
          branch: c.picker.branch,
          compare: c.picker.compare ? "1" : null,
        }),
      },
    ],
  },
  {
    key: "branches",
    group: "Management",
    title: "Branches",
    description: "Each branch side by side: revenue, claims, collections and outstanding.",
    href: "/finance/branches",
    permissions: ["finance.view"],
    uses: ["period"],
    query: months,
  },
  {
    key: "profitability",
    group: "Management",
    title: "Profitability",
    description:
      "Revenue less direct costs by branch, department or doctor (provisional until the month is approved).",
    href: "/finance/profitability",
    permissions: ["finance.profit.view"],
    uses: ["period"],
    query: months,
  },
  // Accounting
  {
    key: "trial-balance",
    group: "Accounting",
    title: "Trial balance",
    description: "Every ledger's opening balance, movements and closing balance from the books.",
    href: "/accounting/trial-balance",
    permissions: ACC_REPORTS,
    uses: ["period"],
    query: dates,
    exports: [{ label: "Excel", href: "/api/accounting/trial-balance", query: dates }],
  },
  {
    key: "profit-and-loss",
    group: "Accounting",
    title: "Profit and loss",
    description: "Income and expenses for the period from the ledger.",
    href: "/accounting/reports/profit-and-loss",
    permissions: ACC_REPORTS,
    uses: ["period", "compare"],
    query: statement(true),
    exports: accountingExports("profit-and-loss", statement(true)),
  },
  {
    key: "balance-sheet",
    group: "Accounting",
    title: "Balance sheet",
    description: "Assets, liabilities and equity at the end of the period.",
    href: "/accounting/reports/balance-sheet",
    permissions: ACC_REPORTS,
    uses: ["as_of", "compare"],
    query: statement(true),
    exports: accountingExports("balance-sheet", statement(true)),
  },
  {
    key: "cash-flow",
    group: "Accounting",
    title: "Cash flow",
    description: "Where cash came from and went, by operating, investing and financing.",
    href: "/accounting/reports/cash-flow",
    permissions: ACC_REPORTS,
    uses: ["period"],
    query: statement(false),
    exports: accountingExports("cash-flow", statement(false)),
  },
  {
    key: "budget-vs-actual",
    group: "Accounting",
    title: "Budget against actual",
    description:
      "The period's actuals against the approved budget (choose the budget on the page).",
    href: "/accounting/reports/budget-vs-actual",
    permissions: [
      "accounting.reports.view",
      "accounting.budgets.manage",
      "accounting.journals.approve",
    ],
    uses: ["period", "branch"],
    query: (c) => ({ ...dates(c), branch: c.picker.branch }),
  },
  {
    key: "ratios",
    group: "Accounting",
    title: "Ratios",
    description: "Margins, liquidity and collection days from the ledger.",
    href: "/accounting/reports/ratios",
    permissions: ACC_REPORTS,
    uses: ["period"],
    query: statement(false),
    exports: accountingExports("ratios", statement(false)),
  },
  {
    key: "payables-ageing",
    group: "Accounting",
    title: "Payables ageing",
    description: "What is owed to each supplier and for how long, at the end of the period.",
    href: "/accounting/payables-ageing",
    permissions: PAYABLES,
    uses: ["as_of"],
    query: (c) => ({ as_of: c.to }),
    exports: [
      { label: "Excel", href: "/api/accounting/payables-ageing", query: (c) => ({ as_of: c.to }) },
    ],
  },
  // Receivables and RCM
  {
    key: "insurance-ageing",
    group: "Receivables and RCM",
    title: "Insurance receivables by age",
    description: "Outstanding insurance amounts and claims by payer and age, as of today.",
    href: "/finance/receivables",
    permissions: ["finance.claims.view"],
    uses: ["branch"],
    query: (c) => ({ branch: c.picker.branch }),
    exports: [
      {
        label: "CSV",
        href: "/api/finance/receivables",
        query: (c) => ({ branch: c.picker.branch }),
      },
    ],
  },
  {
    key: "customer-ageing",
    group: "Receivables and RCM",
    title: "Customer ageing",
    description: "What each business customer owes, by days past due, at the end of the period.",
    href: "/accounting/receivables-ageing",
    permissions: RECEIVABLES,
    uses: ["as_of"],
    query: (c) => ({ as_of: c.to }),
  },
  {
    key: "scorecards",
    group: "Receivables and RCM",
    title: "Payer scorecards",
    description:
      "Each payer's rejection rate, days to pay and collection, rated green, amber or red.",
    href: "/finance/scorecards",
    permissions: ["finance.scorecards.view"],
    uses: ["period"],
    query: dates,
  },
  {
    key: "forecast",
    group: "Receivables and RCM",
    title: "Collections forecast",
    description: "Cash expected from insurers in the coming weeks, from today's open claims.",
    href: "/finance/forecast",
    permissions: ["finance.forecast.view"],
    uses: [],
  },
  {
    key: "denials",
    group: "Receivables and RCM",
    title: "Denials",
    description: "Open denial cases with their owners and resubmission deadlines.",
    href: "/finance/denials",
    permissions: ["finance.denials.manage"],
    uses: [],
    exports: [{ label: "Excel", href: "/api/finance/denials/export" }],
  },
  // Tax
  {
    key: "vat-return",
    group: "Tax",
    title: "VAT return (VAT 201)",
    description:
      "The boxes of the VAT 201 return for the period, with the entries behind each box.",
    href: "/accounting/reports/vat-return",
    permissions: ["accounting.reports.view", "accounting.tax.manage"],
    uses: ["period"],
    query: statement(false),
    exports: accountingExports("vat-return", statement(false)),
  },
  {
    key: "corporate-tax",
    group: "Tax",
    title: "Corporate tax bridge",
    description: "From accounting profit to taxable income: a working paper for the tax adviser.",
    href: "/accounting/reports/corporate-tax",
    permissions: ACC_REPORTS,
    uses: ["period"],
    query: statement(false),
    exports: accountingExports("corporate-tax", statement(false)),
  },
];

/** Every key that opens at least one card: the hub page's own gate. */
export const HUB_PERMISSIONS: readonly string[] = [
  ...new Set(REPORT_CARDS.flatMap((c) => c.permissions)),
];

/**
 * The keys that list the hub in the Finance menu: the finance reporting keys. A member who only works denials keeps their
 * own menu (the hub still shows them the Denials card when they open it from Insights).
 */
export const HUB_NAV_PERMISSIONS = [
  "finance.view",
  "finance.flash.view",
  "finance.revenue.view",
  "finance.profit.view",
  "finance.claims.view",
  "finance.scorecards.view",
  "finance.forecast.view",
] as const;

export function hubCardsFor(member: MemberLike): ReportCard[] {
  return REPORT_CARDS.filter((c) => canAny(member, c.permissions));
}

function withQuery(href: string, q: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== null && v !== undefined && v !== "") params.set(k, v);
  const s = params.toString();
  return s ? `${href}?${s}` : href;
}

export function hubContext(picker: HubPicker, today: string, yesterday: string): HubContext {
  const range = periodRange(picker.kind, picker.key)!;
  return { picker, range, to: range.to < today ? range.to : today, today, yesterday };
}

export function cardLinks(
  card: ReportCard,
  c: HubContext,
): { view: string; exports: Array<{ label: string; href: string }> } {
  return {
    view: withQuery(card.href, card.query ? card.query(c) : {}),
    exports: (card.exports ?? []).map((e) => ({
      label: e.label,
      href: withQuery(e.href, e.query ? e.query(c) : {}),
    })),
  };
}

/** The hub's own query string for a picker (the form posts these names back). */
export function hubQuery(p: HubPicker): string {
  return new URLSearchParams({
    period: p.kind,
    key: p.key,
    branch: p.branch ?? "all",
    ...(p.compare ? { compare: "1" } : {}),
  }).toString();
}

/** What the card's e-mail sends for the picked period (the same document as its Excel download), or null. */
export function cardEmail(
  card: ReportCard,
  c: HubContext,
):
  | { report: "daily_flash"; day: string }
  | { report: "monthly_summary"; from: string; to: string; branch: string | null }
  | null {
  if (card.email === "daily_flash") return { report: "daily_flash", day: flashDay(c) };
  if (card.email === "monthly_summary")
    return {
      report: "monthly_summary",
      from: c.range.fromMonth,
      to: c.range.toMonth,
      branch: c.picker.branch,
    };
  return null;
}
