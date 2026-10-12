import { can, type MemberLike } from "@/lib/auth/can";

/**
 * Every Settings page, with the section it sits under and who may see it. One list feeds the
 * Settings sidebar and the command palette so the two never drift apart.
 */
export type SettingsSection =
  "Personal" | "Workspace" | "Channels & integrations" | "Clinic operations" | "Security & audit";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "Personal",
  "Workspace",
  "Channels & integrations",
  "Clinic operations",
  "Security & audit",
];

export type SettingsPage = {
  href: string;
  label: string;
  section: SettingsSection;
  keywords?: readonly string[];
  allow: (member: MemberLike) => boolean;
};

const everyone = () => true;
const admin = (m: MemberLike) => can(m, "settings.manage");

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    href: "/settings/account",
    label: "Account",
    section: "Personal",
    keywords: ["profile", "password"],
    allow: everyone,
  },

  {
    href: "/settings/users",
    label: "Users",
    section: "Workspace",
    keywords: ["invite", "staff", "members"],
    allow: admin,
  },
  {
    href: "/settings/roles",
    label: "Roles",
    section: "Workspace",
    keywords: ["permissions", "access"],
    allow: admin,
  },
  {
    href: "/settings/teams",
    label: "Teams",
    section: "Workspace",
    keywords: ["departments", "routing"],
    allow: admin,
  },
  { href: "/settings/custom-fields", label: "Custom fields", section: "Workspace", allow: admin },
  {
    href: "/settings/tags",
    label: "Tags",
    section: "Workspace",
    keywords: ["labels"],
    allow: (m) => can(m, "contacts.manage"),
  },

  {
    href: "/settings/channels",
    label: "WhatsApp channels",
    section: "Channels & integrations",
    keywords: ["meta", "numbers", "waba"],
    allow: admin,
  },
  {
    href: "/settings/inbox",
    label: "Inbox rules",
    section: "Channels & integrations",
    keywords: ["assignment", "office hours", "sla"],
    allow: admin,
  },
  {
    href: "/settings/unite",
    label: "Unite EMR",
    section: "Channels & integrations",
    keywords: ["sync", "emr"],
    allow: admin,
  },
  {
    href: "/settings/api-keys",
    label: "API keys",
    section: "Channels & integrations",
    allow: admin,
  },
  {
    href: "/settings/webhooks",
    label: "Webhooks",
    section: "Channels & integrations",
    allow: admin,
  },
  {
    href: "/settings/knowledge-base",
    label: "AI & knowledge base",
    section: "Channels & integrations",
    keywords: ["assistant", "faq"],
    allow: (m) => can(m, "settings.manage") || can(m, "kb.manage"),
  },

  {
    href: "/settings/appointments",
    label: "Appointment rules",
    section: "Clinic operations",
    keywords: ["hours", "reminders", "slots"],
    allow: admin,
  },
  {
    href: "/settings/enquiries",
    label: "Enquiry pipelines",
    section: "Clinic operations",
    keywords: ["stages", "sla"],
    allow: admin,
  },

  {
    href: "/settings/activity",
    label: "Activity log",
    section: "Security & audit",
    keywords: ["audit", "history", "who changed"],
    allow: admin,
  },
  {
    href: "/settings/system-health",
    label: "System health",
    section: "Security & audit",
    keywords: ["queues", "jobs", "status"],
    allow: admin,
  },
];

/** The pages this member may open, in section order. */
export function visibleSettingsPages(member: MemberLike): SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => p.allow(member));
}
