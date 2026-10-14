/**
 * First-run checklist (Phase D): three to five first steps per role, shown as a small card on the landing pages until
 * the person dismisses it on that device (components/shell/first-run-checklist.tsx). Pure: the page passes the member;
 * steps the member cannot open are dropped. Plain words, no patient data.
 */
import { can, type MemberLike } from "@/lib/auth/can";

export type FirstStep = {
  id: string;
  text: string;
  href: string;
  permission?: string;
  /** Opens the Ctrl+K quick search instead of following `href`. */
  palette?: boolean;
};
export type FirstRun = { key: string; title: string; steps: FirstStep[] };

const help: FirstStep = {
  id: "help",
  text: "Press ? on any page for its one-minute guide, or watch the training videos",
  href: "/help/training",
};
const search: FirstStep = {
  id: "search",
  text: "Press Ctrl K to jump to any page, patient, enquiry or task",
  href: "/dashboard",
  palette: true,
};
const notifications: FirstStep = {
  id: "notifications",
  text: "Choose how Pulse tells you about new work (push, e-mail, quiet hours)",
  href: "/settings/notifications",
};

const FINANCE: readonly FirstStep[] = [
  {
    id: "hub",
    text: "Open the Reports hub: pick a branch and a month once, then view or download any report",
    href: "/finance/reports",
    permission: "finance.view",
  },
  {
    id: "exceptions",
    text: "Work the Exceptions list: each item says what is wrong and what to do",
    href: "/finance/exceptions",
    permission: "finance.exceptions.manage",
  },
  {
    id: "close",
    text: "Check the Month-end close timetable for the steps you own",
    href: "/finance/close/timetable",
    permission: "finance.close.tasks",
  },
  {
    id: "setup",
    text: "Finance setup (bank accounts, targets, approval tiers) is under Settings",
    href: "/settings",
    permission: "finance.reference.manage",
  },
  help,
];

const ROLE_STEPS: Record<string, readonly FirstStep[]> = {
  receptionist: [
    {
      id: "board",
      text: "Open the Front desk: tap Arrived when a patient walks in",
      href: "/front-desk",
      permission: "frontdesk.use",
    },
    {
      id: "book",
      text: "Book a patient from a free slot in Appointments",
      href: "/appointments",
      permission: "appointments.manage",
    },
    {
      id: "inbox",
      text: "Answer WhatsApp messages in the Inbox (take a chat first)",
      href: "/inbox",
      permission: "inbox.send",
    },
    search,
    help,
  ],
  doctor: [
    {
      id: "my-day",
      text: "Open My day: your patients today, who is waiting and who is next",
      href: "/my-day",
      permission: "appointments.view",
    },
    {
      id: "follow-ups",
      text: "Check Clinical follow-ups for visits that need a call",
      href: "/portal/follow-ups",
      permission: "portal.clinical_followups.read",
    },
    {
      id: "tasks",
      text: "See the tasks assigned to you",
      href: "/tasks",
      permission: "tasks.view",
    },
    help,
  ],
  agent: [
    {
      id: "inbox",
      text: "Open the Inbox and take a conversation",
      href: "/inbox",
      permission: "inbox.send",
    },
    {
      id: "enquiries",
      text: "Move enquiries along the pipeline as patients decide",
      href: "/enquiries",
      permission: "enquiries.view",
    },
    {
      id: "tasks",
      text: "Call back the patients on your task list",
      href: "/tasks",
      permission: "tasks.view",
    },
    search,
    notifications,
  ],
  manager: [
    {
      id: "management",
      text: "Read the Management dashboard: today's numbers against last week",
      href: "/dashboard/management",
      permission: "reports.view",
    },
    {
      id: "team",
      text: "See who is online and what is waiting on the Team lead dashboard",
      href: "/dashboard/team",
      permission: "reports.view",
    },
    {
      id: "rota",
      text: "Check who is on the rota this week",
      href: "/staff/rota",
      permission: "appointments.view",
    },
    {
      id: "reports",
      text: "Open Reports for the detail",
      href: "/reports",
      permission: "reports.view",
    },
    help,
  ],
  ceo: [
    {
      id: "management",
      text: "Read the Management dashboard",
      href: "/dashboard/management",
      permission: "reports.view",
    },
    {
      id: "hub",
      text: "Open the finance Reports hub for revenue, claims and profit",
      href: "/finance/reports",
      permission: "finance.view",
    },
    {
      id: "close",
      text: "Sign off the month in Month-end close when Finance has finished",
      href: "/finance/close",
      permission: "finance.close.signoff.ceo",
    },
    help,
  ],
  hr: [
    {
      id: "staff",
      text: "Add your staff records (no pay amounts here)",
      href: "/staff",
      permission: "hr.view",
    },
    { id: "rota", text: "Plan the week in the Rota", href: "/staff/rota", permission: "hr.view" },
    {
      id: "doctors",
      text: "Check doctors' licence expiry dates in Doctors",
      href: "/doctors",
      permission: "hr.view",
    },
    help,
  ],
  marketing: [
    {
      id: "templates",
      text: "Write a WhatsApp template and send it to Meta for approval",
      href: "/templates",
      permission: "templates.manage",
    },
    {
      id: "campaign",
      text: "Plan a campaign: choose who gets it, preview it, then schedule it",
      href: "/campaigns",
      permission: "campaigns.view",
    },
    {
      id: "flows",
      text: "Automate replies with a flow (try it with Dry run first)",
      href: "/flows",
      permission: "flows.manage",
    },
    help,
  ],
  "care coordinator": [
    {
      id: "follow-ups",
      text: "Work Clinical follow-ups from the top: High first",
      href: "/portal/follow-ups",
      permission: "portal.clinical_followups.read",
    },
    {
      id: "inbox",
      text: "Reply to patients in the Inbox",
      href: "/inbox",
      permission: "inbox.send",
    },
    {
      id: "appointments",
      text: "Book follow-up visits in Appointments",
      href: "/appointments",
      permission: "appointments.manage",
    },
    help,
  ],
  accountant: [
    {
      id: "waiting",
      text: "See what is waiting to post to the ledger",
      href: "/accounting/waiting",
      permission: "accounting.ledger.view",
    },
    {
      id: "journals",
      text: "Prepare a journal; someone else posts it",
      href: "/accounting/journals",
      permission: "accounting.journals.prepare",
    },
    {
      id: "tb",
      text: "Check the trial balance",
      href: "/accounting/trial-balance",
      permission: "accounting.reports.view",
    },
    help,
  ],
  admin: [
    {
      id: "readiness",
      text: "Work through the Go-live checklist",
      href: "/settings/readiness",
      permission: "settings.manage",
    },
    {
      id: "users",
      text: "Invite your team and give each person a role",
      href: "/settings/users",
      permission: "settings.manage",
    },
    {
      id: "branches",
      text: "Set up your branches, doctors and working hours",
      href: "/settings/appointments?tab=locations",
      permission: "settings.manage",
    },
    {
      id: "training",
      text: "Turn on Training mode to practise without messaging patients",
      href: "/settings/training",
      permission: "settings.manage",
    },
    help,
  ],
};

const ALIASES: Record<string, string> = {
  "chief accountant": "accountant",
  auditor: "accountant",
  finance: "finance",
  "finance manager": "finance",
  billing: "finance",
  insurance: "finance",
  "medical director": "finance",
  "cost / payroll": "finance",
  "department head": "finance",
  operations: "finance",
};

const DEFAULT_STEPS: readonly FirstStep[] = [search, notifications, help];

/** The member's first steps (only those they can open), keyed by role for the per-device dismissal. */
export function firstRunFor(member: MemberLike & { roleName?: string }): FirstRun {
  const role = (member.roleName ?? "").trim().toLowerCase();
  const key = ALIASES[role] ?? (ROLE_STEPS[role] ? role : "default");
  const steps = key === "finance" ? FINANCE : (ROLE_STEPS[key] ?? DEFAULT_STEPS);
  const mine = steps.filter((s) => !s.permission || can(member, s.permission)).slice(0, 5);
  // a role holding only part of its preset still gets at least three steps
  for (const s of DEFAULT_STEPS)
    if (mine.length < 3 && !mine.some((m) => m.id === s.id)) mine.push(s);
  return { key, title: "Your first steps in Pulse", steps: mine };
}

/** localStorage key for "dismissed on this device" (one per role, so a new role shows its own list). */
export function firstRunStorageKey(key: string): string {
  return `pulse-first-run-dismissed:${key}`;
}
