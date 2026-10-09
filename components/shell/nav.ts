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
  | "settings";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  permission?: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/inbox", label: "Inbox", icon: "inbox" },
  { href: "/contacts", label: "Contacts", icon: "contacts", permission: "contacts.view" },
  { href: "/enquiries", label: "Enquiries", icon: "enquiries", permission: "enquiries.view" },
  { href: "/tasks", label: "Tasks", icon: "tasks" },
  {
    href: "/appointments",
    label: "Appointments",
    icon: "appointments",
    permission: "appointments.view",
  },
  { href: "/campaigns", label: "Campaigns", icon: "campaigns", permission: "campaigns.view" },
  { href: "/templates", label: "Templates", icon: "templates", permission: "templates.manage" },
  { href: "/flows", label: "Flows", icon: "flows", permission: "flows.manage" },
  { href: "/recall", label: "Recall", icon: "recall", permission: "campaigns.view" },
  { href: "/portal", label: "Portal", icon: "portal" },
  { href: "/reports", label: "Reports", icon: "reports", permission: "reports.view" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export const SIDEBAR_COOKIE = "pulse_sidebar";
