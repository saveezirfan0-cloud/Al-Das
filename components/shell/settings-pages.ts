import { can, canAny, type MemberLike } from "@/lib/auth/can";
import { SIGNING_PERMS } from "@/lib/signing/perms";

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
    href: "/settings/notifications",
    label: "Notifications",
    section: "Personal",
    keywords: [
      "push",
      "alerts",
      "quiet hours",
      "digest",
      "escalation",
      "on call",
      "sound",
      "e-mail",
    ],
    allow: everyone,
  },
  {
    href: "/settings/signing-certificate",
    label: "Signing certificate",
    section: "Personal",
    keywords: ["digital signature", "dsc", "p12", "pfx", "certificate", "sign", "pin"],
    allow: (m) => canAny(m, SIGNING_PERMS),
  },

  {
    href: "/settings/readiness",
    label: "Go-live checklist",
    section: "Workspace",
    keywords: ["setup", "go live", "checklist", "readiness", "connections"],
    allow: admin,
  },
  {
    href: "/settings/users",
    label: "Users",
    section: "Workspace",
    keywords: ["invite", "staff", "members", "open conversation limit", "enquiry view"],
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
    keywords: ["departments", "routing", "auto-reply", "fallback team", "office hours"],
    allow: admin,
  },
  { href: "/settings/custom-fields", label: "Custom fields", section: "Workspace", allow: admin },
  {
    href: "/settings/tags",
    label: "Tags",
    section: "Workspace",
    keywords: ["labels", "enquiry tags", "portal tags"],
    allow: (m) =>
      can(m, "contacts.manage") || can(m, "enquiries.manage") || can(m, "portal.tags.manage"),
  },

  {
    href: "/settings/training",
    label: "Training mode",
    section: "Workspace",
    keywords: ["sandbox", "demo", "practice", "videos", "help", "onboarding"],
    allow: admin,
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
    keywords: ["assignment", "office hours", "sla", "away", "idle"],
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
    href: "/settings/integrations",
    label: "Integrations",
    section: "Channels & integrations",
    keywords: [
      "sms",
      "text message",
      "fallback",
      "payment",
      "payment link",
      "stripe",
      "paytabs",
      "calendar",
      "ics",
      "outlook",
      "google calendar",
      "feed",
      "gateway",
      "seal",
      "digital signature",
      "pades",
    ],
    allow: (m) => can(m, "integrations.manage") || can(m, "integrations.calendar"),
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
    href: "/settings/ai-copilots",
    label: "AI copilots",
    section: "Channels & integrations",
    keywords: [
      "ai",
      "flow copilot",
      "campaign copilot",
      "intent",
      "emergency",
      "tags",
      "label messages",
      "clinical sign-off",
    ],
    allow: (m) => can(m, "settings.manage") || can(m, "clinical.settings.manage"),
  },

  {
    href: "/settings/appointments",
    label: "Appointment rules",
    section: "Clinic operations",
    keywords: ["hours", "reminders", "slots"],
    allow: admin,
  },
  {
    href: "/settings/front-desk",
    label: "Front desk",
    section: "Clinic operations",
    keywords: [
      "waitlist",
      "waiting list",
      "offers",
      "qr",
      "walk-in",
      "check in",
      "running late",
      "location message",
    ],
    allow: admin,
  },
  {
    href: "/settings/documents",
    label: "Patient documents",
    section: "Clinic operations",
    keywords: [
      "documents",
      "insurance card",
      "referral",
      "lab report",
      "consent",
      "retention",
      "storage",
      "malware",
      "expiry",
      "usage",
    ],
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
    keywords: [
      "audit",
      "history",
      "who changed",
      "login history",
      "sign-ins",
      "record access",
      "who opened",
    ],
    allow: admin,
  },
  {
    href: "/settings/security",
    label: "Security",
    section: "Security & audit",
    keywords: ["mfa", "two-step", "2fa", "authenticator", "retention", "alerts", "off hours"],
    allow: (m) => can(m, "security.manage"),
  },
  {
    href: "/settings/access-review",
    label: "Access review",
    section: "Security & audit",
    keywords: ["quarterly", "dormant", "attest", "sign off", "who has access", "off-boarding"],
    allow: (m) => can(m, "security.manage"),
  },
  {
    href: "/settings/privacy",
    label: "Patient data requests",
    section: "Security & audit",
    keywords: [
      "export",
      "erasure",
      "delete patient",
      "gdpr",
      "subject access",
      "right to be forgotten",
    ],
    allow: (m) => can(m, "privacy.manage"),
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
