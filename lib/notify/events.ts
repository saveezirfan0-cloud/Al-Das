/**
 * Notification events a person can choose how to receive. Keys are stable: they are stored in
 * notification_preferences.event. Keep this file framework-free (shared by server, client and tests).
 *
 * Channels: in_app (the bell and the notification centre), email, push (Web Push to a registered device).
 * Defaults apply until the person saves a choice: everything in-app, urgent work also pushed, e-mail off.
 */

export const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: "In the app",
  email: "E-mail",
  push: "Push to my devices",
};

export type NotificationEventDef = {
  key: string;
  group: "Inbox" | "Work" | "Escalation" | "Digests";
  label: string;
  description: string;
  /** Channels that make sense for this event. */
  channels: readonly NotificationChannel[];
  /** What is on before the person chooses anything. */
  defaults: Readonly<Record<NotificationChannel, boolean>>;
  /** Urgent events ignore quiet hours (nobody has picked the conversation up). */
  urgent?: boolean;
  /** The member needs this permission to be offered the event at all. */
  permission?: string;
};

const ALL: readonly NotificationChannel[] = ["in_app", "email", "push"];

export const NOTIFICATION_EVENTS = [
  {
    key: "inbox.message",
    group: "Inbox",
    label: "New message on my conversation",
    description: "A patient writes in a conversation assigned to you (first unread message only).",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
  },
  {
    key: "inbox.assigned",
    group: "Inbox",
    label: "A conversation is assigned to me",
    description: "A colleague, the auto-assignment or a flow hands you a conversation.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
  },
  {
    key: "inbox.unread",
    group: "Inbox",
    label: "My conversation is still unread",
    description:
      "A conversation assigned to you has had unread messages for longer than the limit set under Settings, Inbox. Push and e-mail say only that a conversation is waiting.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
  },
  {
    key: "inbox.mention",
    group: "Inbox",
    label: "Someone mentions me",
    description: "A colleague @mentions you in an internal note.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
  },
  {
    key: "sla.breach",
    group: "Work",
    label: "An enquiry SLA is breached",
    description: "An open enquiry was not touched within its first-response time.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
  },
  {
    key: "reminder.failed",
    group: "Work",
    label: "An appointment reminder failed",
    description: "A reminder could not be delivered, so someone should call the patient.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "appointments.view",
  },
  {
    key: "waitlist.booked",
    group: "Work",
    label: "A waiting-list offer was accepted",
    description: "A patient on the waiting list said YES and took a freed slot.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "frontdesk.use",
  },
  {
    key: "document.expiring",
    group: "Work",
    label: "A patient's insurance card is about to expire",
    description:
      "An insurance card in a patient's documents reaches its reminder date (set under Settings, Documents). Push and e-mail say only that a card is expiring; open Pulse to see whose.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "documents.manage",
  },
  {
    key: "staff.document_expiring",
    group: "Work",
    label: "A staff visa or licence is about to expire",
    description:
      "A staff member's visa or licence, or a doctor's licence, reaches its reminder date (60 days by default; Staff, Reminder days). Push and e-mail say only that one is expiring; open Pulse to see whose.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "hr.manage",
  },
  {
    key: "esign.update",
    group: "Work",
    label: "A consent form you sent for signature has an update",
    description:
      "A patient signed, declined or let a consent form expire. Push and e-mail only say that one has an update; open Pulse to see which.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "documents.manage",
  },
  {
    key: "finance.preauth_expiring",
    group: "Work",
    label: "A pre-authorisation is about to expire",
    description:
      "An approved insurance pre-authorisation reaches its reminder date (Finance, Workflow settings). Push and e-mail say only that one is expiring; open Pulse to see which.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "finance.preauth.manage",
  },
  {
    key: "finance.denial_deadline",
    group: "Work",
    label: "A denied claim is close to its resubmission deadline",
    description:
      "A denial case that is still being worked is within the warning window (or past) its resubmission deadline. Push and e-mail say only that a deadline is close.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "finance.denials.manage",
  },
  {
    key: "finance.followup_due",
    group: "Work",
    label: "An unpaid insurance claim needs a follow-up",
    description:
      "An unpaid claim reached a follow-up stage (60, 90 or 120 days by default; Finance, Workflow settings) and a task was created. Push and e-mail say only that a follow-up is due.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "finance.followup.manage",
  },
  {
    key: "finance.close_due",
    group: "Work",
    label: "A month-end close step of mine is due or overdue",
    description:
      "A close timetable step you own (Finance, Close timetable) is due today or late. At most one a day, on working days. Push and e-mail say only that a step is due.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "finance.close.tasks",
  },
  {
    key: "finance.voucher_to_check",
    group: "Work",
    label: "A payment voucher is waiting for verification",
    description:
      "A maker submitted a payment voucher with its backup. Push and e-mail say only that one is waiting; open Pulse to see which.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "finance.vouchers.check",
  },
  {
    key: "finance.voucher_to_approve_dept",
    group: "Work",
    label: "A payment voucher needs a department head",
    description:
      "The Finance Manager verified a Tier 2 voucher and it waits for a department head. Push and e-mail say only that one is waiting.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "finance.vouchers.approve_dept",
  },
  {
    key: "finance.voucher_to_approve",
    group: "Work",
    label: "A payment voucher needs the CEO",
    description:
      "A verified Tier 3, Tier 4 or special-category voucher waits for the CEO's authorisation. Push and e-mail say only that one is waiting.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "finance.vouchers.approve_ceo",
  },
  {
    key: "finance.voucher_rejected",
    group: "Work",
    label: "My payment voucher was rejected",
    description:
      "A voucher you prepared was rejected; the remarks are in Pulse. Push and e-mail say only that one was rejected.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    permission: "finance.vouchers.prepare",
  },
  {
    key: "accounting.runs_prepared",
    group: "Work",
    label: "Month-end depreciation and schedule runs are ready",
    description:
      "On the first working day of a month Pulse prepares last month's depreciation and schedule runs for review. Push and e-mail say only that runs are ready.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "accounting.assets.manage",
  },
  {
    key: "ai.insights_ready",
    group: "Work",
    label: "The weekly AI reply-quality report is ready",
    description:
      "Last week's AI suggestions accepted, edited and rejected, and the topics the knowledge base does not cover. Push and e-mail only say that the report is ready.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: false },
    permission: "ai.insights.view",
  },
  {
    key: "task.due",
    group: "Work",
    label: "A task is due",
    description: "A task assigned to you has reached its due time.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
  },
  {
    key: "escalation",
    group: "Escalation",
    label: "A conversation was not picked up",
    description:
      "You are the team lead or on call, and a conversation has had no owner for too long.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    urgent: true,
  },
  {
    key: "inbox.emergency",
    group: "Escalation",
    label: "A patient message may describe an emergency",
    description:
      "The words in a patient's message suggest something urgent (for example chest pain, trouble breathing, heavy bleeding or thoughts of self-harm). It goes to the person who owns the conversation, the team lead and the on-call people at once. It is a prompt to look, not a diagnosis; push and e-mail say only that a message needs attention.",
    channels: ALL,
    defaults: { in_app: true, email: false, push: true },
    urgent: true,
  },
  {
    key: "digest.daily",
    group: "Digests",
    label: "Daily management digest",
    description: "The Management dashboard numbers for yesterday, by e-mail each morning.",
    channels: ["email"],
    defaults: { in_app: false, email: false, push: false },
    permission: "reports.view",
  },
  {
    key: "digest.weekly",
    group: "Digests",
    label: "Weekly management digest",
    description: "The Management dashboard numbers for last week, by e-mail on Monday morning.",
    channels: ["email"],
    defaults: { in_app: false, email: false, push: false },
    permission: "reports.view",
  },
] as const satisfies readonly NotificationEventDef[];

export type NotificationEventKey = (typeof NOTIFICATION_EVENTS)[number]["key"];

export const EVENT_KEYS: readonly string[] = NOTIFICATION_EVENTS.map((e) => e.key);

export function getEvent(key: string): NotificationEventDef | undefined {
  return (NOTIFICATION_EVENTS as readonly NotificationEventDef[]).find((e) => e.key === key);
}

export function isEventKey(key: string): key is NotificationEventKey {
  return EVENT_KEYS.includes(key);
}

/** The events this member may be offered (permission-gated ones are hidden without it). */
export function eventsFor(canDo: (permission: string) => boolean): NotificationEventDef[] {
  return (NOTIFICATION_EVENTS as readonly NotificationEventDef[]).filter(
    (e) => !e.permission || canDo(e.permission),
  );
}

/** notifications.type values written by the app → the filter group shown in the notification centre. */
export type NotificationCategory = "inbox" | "work" | "escalation" | "security" | "system";

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  inbox: "Inbox",
  work: "Tasks & enquiries",
  escalation: "Escalations",
  security: "Security",
  system: "System",
};

export function categoryForType(type: string): NotificationCategory {
  if (type.startsWith("inbox.") || type === "mention") return "inbox";
  if (type === "escalation") return "escalation";
  if (
    type.startsWith("task.") ||
    type.startsWith("enquiry.") ||
    type.startsWith("appointment.") ||
    type.startsWith("document.") ||
    type.startsWith("staff.") ||
    type === "ai.insights_ready" ||
    type === "finance.preauth_expiring" ||
    type === "finance.denial_deadline" ||
    type === "finance.followup_due" ||
    type === "finance.close_due" ||
    type === "accounting.runs_prepared" ||
    type.startsWith("finance.voucher_") ||
    type === "reminder.failed"
  )
    return "work";
  if (type.startsWith("security.") || type.startsWith("alert.")) return "security";
  return "system";
}

/** The inverse, for SQL filters: a list of exact types and prefixes ("inbox.") that belong to a category. */
export function typeFilterForCategory(category: NotificationCategory): {
  exact: string[];
  prefixes: string[];
} {
  switch (category) {
    case "inbox":
      return { exact: ["mention"], prefixes: ["inbox."] };
    case "escalation":
      return { exact: ["escalation"], prefixes: [] };
    case "work":
      return {
        exact: [
          "reminder.failed",
          "finance.preauth_expiring",
          "finance.denial_deadline",
          "finance.followup_due",
          "finance.close_due",
          "finance.voucher_to_check",
          "finance.voucher_to_approve_dept",
          "finance.voucher_to_approve",
          "finance.voucher_rejected",
          "ai.insights_ready",
          "accounting.runs_prepared",
        ],
        prefixes: ["task.", "enquiry.", "appointment.", "document.", "staff."],
      };
    case "security":
      return { exact: [], prefixes: ["security.", "alert."] };
    case "system":
      return { exact: [], prefixes: [] };
  }
}
