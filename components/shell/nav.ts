import { PORTAL_SECTIONS } from "@/app/(app)/portal/sections";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";

/** Left-nav modules. `permission` hides the entry for members without it. */
export type NavIcon =
  | "dashboard"
  | "frontdesk"
  | "inbox"
  | "contacts"
  | "enquiries"
  | "tasks"
  | "appointments"
  | "campaigns"
  | "templates"
  | "flows"
  | "media"
  | "recall"
  | "portal"
  | "reports"
  | "finance"
  | "settings";

export type NavGroup = "Today" | "Patients" | "Growth" | "Insight & back office";

/** Section order in the sidebar and command palette. Dashboard and Settings sit outside the groups. */
export const NAV_GROUPS: readonly NavGroup[] = [
  "Today",
  "Patients",
  "Growth",
  "Insight & back office",
];

export type NavItem = {
  href: string;
  /** Sidebar section. Items without one render above (Dashboard) or below (Settings) the groups. */
  group?: NavGroup;
  /** Extra words the command palette matches on (e.g. "calendar" for Appointments). */
  keywords?: readonly string[];
  label: string;
  icon: NavIcon;
  permission?: string;
  /** Count shown next to the label (e.g. overdue tasks). */
  badge?: number;
  /** Visible when the member holds at least one of these. */
  permissions?: readonly string[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  {
    href: "/front-desk",
    label: "Front desk",
    icon: "frontdesk",
    group: "Today",
    keywords: ["reception", "check in", "arrivals", "walk-in", "waitlist", "waiting list", "handover"],
    permission: "frontdesk.use",
  },
  {
    href: "/inbox",
    label: "Inbox",
    icon: "inbox",
    group: "Today",
    keywords: ["whatsapp", "messages", "chat"],
  },
  {
    href: "/contacts",
    label: "Contacts",
    icon: "contacts",
    group: "Patients",
    keywords: ["patients", "crm"],
    permission: "contacts.view",
  },
  {
    href: "/enquiries",
    label: "Enquiries",
    icon: "enquiries",
    group: "Patients",
    keywords: ["leads", "pipeline"],
    permission: "enquiries.view",
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: "tasks",
    group: "Today",
    keywords: ["to do", "calls"],
    permission: "tasks.view",
  },
  {
    href: "/appointments",
    label: "Appointments",
    icon: "appointments",
    group: "Today",
    keywords: ["calendar", "bookings", "diary"],
    permission: "appointments.view",
  },
  {
    href: "/campaigns",
    label: "Campaigns",
    icon: "campaigns",
    group: "Growth",
    keywords: ["broadcast", "marketing", "copilot", "ai audience"],
    permission: "campaigns.view",
  },
  {
    href: "/templates",
    label: "Templates",
    icon: "templates",
    group: "Growth",
    keywords: ["whatsapp", "messages"],
    permission: "templates.manage",
  },
  {
    href: "/media",
    label: "Media Library",
    icon: "media",
    group: "Growth",
    keywords: ["images", "pictures", "photos", "pdf", "video", "files", "assets", "brochure"],
    permissions: ["media.view", "media.manage"],
  },
  {
    href: "/flows",
    label: "Flows",
    icon: "flows",
    group: "Growth",
    keywords: ["bots", "automation", "ai draft", "dry run", "copilot"],
    permission: "flows.manage",
  },
  {
    href: "/recall",
    label: "Recall",
    icon: "recall",
    group: "Growth",
    keywords: ["birthday", "chronic", "follow up"],
    permission: "campaigns.view",
  },
  {
    href: "/portal",
    label: "Portal",
    icon: "portal",
    group: "Insight & back office",
    keywords: ["back office", "reference data", "airtable"],
    permissions: [...PORTAL_SECTIONS.map((x) => x.read), ...PORTAL_OBJECTS.map((o) => o.readPerm)],
  },
  {
    href: "/reports",
    label: "Reports",
    icon: "reports",
    group: "Insight & back office",
    keywords: ["analytics", "export", "ai quality", "knowledge gaps"],
    permission: "reports.view",
  },
  {
    href: "/finance",
    label: "Finance",
    icon: "finance",
    group: "Insight & back office",
    keywords: ["invoices", "insurance", "claims", "denials", "pre-authorisation", "remittance", "forecast", "cash-up", "month-end", "revenue", "flash", "daily summary", "targets", "arpp", "follow-up", "receivables", "ageing", "arp", "billing mix", "seasonality", "trends", "close timetable", "working day", "vouchers", "payment voucher", "suppliers", "supplier invoices", "payables", "approvals", "tally", "bank reconciliation", "bank statement", "settlement", "tabby", "card settlement", "invoice changes", "discounts", "cancellations", "refunds"],
    permissions: [
      "finance.view",
      "finance.invoices.view",
      "finance.claims.view",
      "finance.claims.import",
      "finance.reference.manage",
      "finance.exceptions.manage",
      "finance.capture.manage",
      "finance.preauth.manage",
      "finance.eligibility.manage",
      "finance.denials.manage",
      "finance.remittance.manage",
      "finance.scorecards.view",
      "finance.forecast.view",
      "finance.recovery.manage",
      "finance.recovery.approve",
      "finance.payment_links",
      "finance.close.view",
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.close.signoff.ceo",
      "finance.cashup.manage",
      "finance.revenue.view",
      "finance.export.run",
      "finance.costs.manage",
      "finance.costs.view",
      "finance.costs.compensation",
      "finance.profit.view",
      "finance.profit.approve",
      "finance.flash.view",
      "finance.targets.manage",
      "finance.close.tasks",
      "finance.payables.view",
      "finance.payables.manage",
      "finance.vouchers.prepare",
      "finance.vouchers.check",
      "finance.vouchers.approve_dept",
      "finance.vouchers.approve_ceo",
      "finance.vouchers.pay",
      "finance.vouchers.settings",
      "finance.tally.export",
      "finance.bank.view",
      "finance.bank.manage",
      "finance.bank.signoff",
      "finance.changes.review",
      "finance.changes.view",
    ],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    keywords: ["users", "roles", "channels"],
  },
];

export const SIDEBAR_COOKIE = "pulse_sidebar";
