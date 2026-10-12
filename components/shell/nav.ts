import { PORTAL_SECTIONS } from "@/app/(app)/portal/sections";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";

/** Left-nav modules. `permission` hides the entry for members without it. */
export type NavIcon =
  | "dashboard"
  | "inbox"
  | "contacts"
  | "enquiries"
  | "tasks"
  | "appointments"
  | "campaigns"
  | "templates"
  | "flows"
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
    keywords: ["broadcast", "marketing"],
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
    href: "/flows",
    label: "Flows",
    icon: "flows",
    group: "Growth",
    keywords: ["bots", "automation"],
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
    keywords: ["analytics", "export"],
    permission: "reports.view",
  },
  {
    href: "/finance",
    label: "Finance",
    icon: "finance",
    group: "Insight & back office",
    keywords: ["invoices", "insurance", "claims"],
    permissions: [
      "finance.view",
      "finance.invoices.view",
      "finance.claims.view",
      "finance.exceptions.manage",
      "finance.capture.manage",
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
