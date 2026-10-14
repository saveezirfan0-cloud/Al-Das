import { PORTAL_SECTIONS } from "@/app/(app)/portal/sections";
import { ACCOUNTING_KEYS } from "@/lib/accounting/nav";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";

/** Left-nav modules. `permission` hides the entry for members without it. */
export type NavIcon =
  | "dashboard"
  | "frontdesk"
  | "myday"
  | "doctors"
  | "staff"
  | "rota"
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
  | "followups"
  | "teams"
  | "branches"
  | "management"
  | "portal"
  | "reports"
  | "finance"
  | "accounting"
  | "settings";

export type NavGroup = "Today" | "Messaging" | "CRM" | "Back office" | "Insights";

/**
 * Section order in the sidebar and command palette (docs/34 §3). Dashboard and Settings sit outside the groups. On the
 * desktop rail each group is one area of plain pages, and each module with sections (Finance, Accounting) is an area of
 * its own placed at its group's position; "Back office" holds only those modules.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  "Today",
  "Messaging",
  "CRM",
  "Back office",
  "Insights",
];

/** Sub-headings inside the CRM group (docs/34 §3: People and Organisation). */
export type NavSubgroup = "People" | "Organisation";

export type NavItem = {
  href: string;
  /** Sidebar section. Items without one render above (Dashboard) or below (Settings) the groups. */
  group?: NavGroup;
  /** A sub-heading inside the group (CRM: People, Organisation). Items of one subgroup sit together in the list. */
  subgroup?: NavSubgroup;
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
  // Today: the day's work at the clinic
  {
    href: "/front-desk",
    label: "Front desk",
    icon: "frontdesk",
    group: "Today",
    keywords: [
      "reception",
      "check in",
      "arrivals",
      "walk-in",
      "waitlist",
      "waiting list",
      "handover",
    ],
    permission: "frontdesk.use",
  },
  {
    href: "/my-day",
    label: "My day",
    icon: "myday",
    group: "Today",
    keywords: ["doctor", "my patients", "today's list", "my appointments", "clinic day"],
    permission: "appointments.view",
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
    href: "/tasks",
    label: "Tasks",
    icon: "tasks",
    group: "Today",
    keywords: ["to do", "calls"],
    permission: "tasks.view",
  },
  {
    // the clinical Follow-Up Queue, moved here from Portal (docs/34 §3); the page itself stays under /portal
    href: "/portal/follow-ups",
    label: "Clinical follow-ups",
    icon: "followups",
    group: "Today",
    keywords: ["follow-up queue", "clinical rules", "nurse calls", "check-ins"],
    permission: "portal.clinical_followups.read",
  },
  // Messaging: the WhatsApp side (what Sanoflow did)
  {
    href: "/inbox",
    label: "Inbox",
    icon: "inbox",
    group: "Messaging",
    keywords: ["whatsapp", "messages", "chat", "conversations"],
    // only people who can answer or read patients' chats (docs/34 Phase D)
    permissions: ["inbox.send", "inbox.view_all"],
  },
  {
    href: "/templates",
    label: "Templates",
    icon: "templates",
    group: "Messaging",
    keywords: ["whatsapp", "messages", "approved messages"],
    permission: "templates.manage",
  },
  {
    href: "/campaigns",
    label: "Campaigns",
    icon: "campaigns",
    group: "Messaging",
    keywords: ["broadcast", "marketing", "copilot", "ai audience"],
    permission: "campaigns.view",
  },
  {
    href: "/flows",
    label: "Flows",
    icon: "flows",
    group: "Messaging",
    keywords: ["bots", "automation", "ai draft", "dry run", "copilot"],
    permission: "flows.manage",
  },
  {
    href: "/recall",
    label: "Recall",
    icon: "recall",
    group: "Messaging",
    keywords: ["birthday", "chronic", "follow up"],
    permission: "campaigns.view",
  },
  {
    href: "/media",
    label: "Media Library",
    icon: "media",
    group: "Messaging",
    keywords: ["images", "pictures", "photos", "pdf", "video", "files", "assets", "brochure"],
    permissions: ["media.view", "media.manage"],
  },
  // CRM: the people we serve, and the organisation that serves them
  {
    href: "/contacts",
    label: "Patients",
    icon: "contacts",
    group: "CRM",
    subgroup: "People",
    keywords: ["contacts", "crm", "people"],
    permission: "contacts.view",
  },
  {
    href: "/enquiries",
    label: "Enquiries",
    icon: "enquiries",
    group: "CRM",
    subgroup: "People",
    keywords: ["leads", "pipeline"],
    permission: "enquiries.view",
  },
  {
    href: "/doctors",
    label: "Doctors",
    icon: "doctors",
    group: "CRM",
    subgroup: "Organisation",
    keywords: ["specialists", "physicians", "licence", "dha", "working hours", "organisation"],
    permissions: ["appointments.view", "hr.view"],
  },
  {
    href: "/staff",
    label: "Staff",
    icon: "staff",
    group: "CRM",
    subgroup: "Organisation",
    keywords: ["hr", "employees", "rota", "shifts", "duties", "visa", "organisation"],
    permission: "hr.view",
  },
  {
    href: "/staff/rota",
    label: "Rota",
    icon: "rota",
    group: "CRM",
    keywords: ["shifts", "who is on", "schedule", "week", "duty roster", "staff"],
    permissions: ["hr.view", "appointments.view"],
  },
  {
    // the Teams settings page, listed where people look for it (docs/34 Phase C); no longer repeated under Settings
    href: "/settings/teams",
    label: "Teams",
    icon: "teams",
    group: "CRM",
    subgroup: "Organisation",
    keywords: [
      "departments",
      "routing",
      "auto-reply",
      "fallback team",
      "office hours",
      "organisation",
    ],
    permission: "settings.manage",
  },
  {
    // branches are the Locations tab of Appointment rules (address, finance branch code, review link)
    href: "/settings/appointments?tab=locations",
    label: "Branches",
    icon: "branches",
    group: "CRM",
    subgroup: "Organisation",
    keywords: ["locations", "clinics", "sites", "branch code", "organisation"],
    permission: "settings.manage",
  },
  // Insights: how the clinic is doing
  {
    href: "/reports",
    label: "Reports",
    icon: "reports",
    group: "Insights",
    keywords: ["analytics", "export", "ai quality", "knowledge gaps", "reports hub"],
    permission: "reports.view",
  },
  {
    href: "/dashboard/management",
    label: "Management",
    icon: "management",
    group: "Insights",
    keywords: ["kpis", "ceo", "management dashboard", "digest"],
    permission: "reports.view",
  },
  {
    href: "/portal",
    label: "Portal",
    icon: "portal",
    group: "Insights",
    keywords: ["back office", "reference data", "airtable"],
    permissions: [...PORTAL_SECTIONS.map((x) => x.read), ...PORTAL_OBJECTS.map((o) => o.readPerm)],
  },
  {
    href: "/finance",
    label: "Finance",
    icon: "finance",
    group: "Back office",
    keywords: [
      "invoices",
      "insurance",
      "claims",
      "denials",
      "pre-authorisation",
      "remittance",
      "forecast",
      "cash-up",
      "month-end",
      "revenue",
      "flash",
      "daily summary",
      "targets",
      "arpp",
      "follow-up",
      "receivables",
      "ageing",
      "arp",
      "billing mix",
      "seasonality",
      "trends",
      "close timetable",
      "working day",
      "vouchers",
      "payment voucher",
      "suppliers",
      "supplier invoices",
      "payables",
      "approvals",
      "tally",
      "bank reconciliation",
      "bank statement",
      "settlement",
      "tabby",
      "card settlement",
      "invoice changes",
      "discounts",
      "cancellations",
      "refunds",
      "revenue share",
      "doctor incentives",
      "doctor charges",
      "payout",
      "finance inbox",
      "accounts mailbox",
      "processor report",
      "labs",
      "lab reconciliation",
      "send-out lab",
      "referrals",
      "radiology",
      "turnaround",
    ],
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
      "finance.inbox.manage",
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
      "finance.labs.view",
      "finance.labs.manage",
      "finance.changes.review",
      "finance.changes.view",
      "finance.revshare.view",
      "finance.revshare.manage",
      "finance.revshare.verify",
      "finance.revshare.approve",
    ],
  },
  {
    href: "/accounting",
    label: "Accounting",
    icon: "accounting",
    group: "Back office",
    keywords: [
      "ledger",
      "general ledger",
      "chart of accounts",
      "journals",
      "journal entry",
      "day book",
      "trial balance",
      "periods",
      "fiscal year",
      "tax codes",
      "vat",
      "cost centres",
      "entities",
      "tally",
      "double entry",
      "books",
    ],
    permissions: ACCOUNTING_KEYS,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    keywords: ["users", "roles", "channels"],
  },
];

export const SIDEBAR_COOKIE = "pulse_sidebar";
