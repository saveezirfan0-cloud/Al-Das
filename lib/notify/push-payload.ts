import { getEvent } from "@/lib/notify/events";

/**
 * What a push message carries. By construction it takes ids only: there is no parameter that could hold a
 * patient name, a phone number or message text (CLAUDE.md rule 10). The title and body are fixed generic
 * sentences per event; the service worker opens `url`, and the signed-in app shows the real content.
 */
export type PushIds = {
  conversation_id?: string | null;
  task_id?: string | null;
  enquiry_id?: string | null;
  appointment_id?: string | null;
};

export type PushPayload = {
  v: 1;
  event: string;
  title: string;
  body: string;
  /** Same-origin path the notification opens. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  ids: PushIds;
};

const GENERIC: Record<string, { title: string; body: string }> = {
  "inbox.message": { title: "New message", body: "A patient replied. Open the conversation." },
  "inbox.assigned": { title: "Conversation assigned", body: "A conversation was assigned to you." },
  "inbox.mention": { title: "You were mentioned", body: "A colleague mentioned you in a note." },
  "sla.breach": { title: "SLA breached", body: "An enquiry is past its response time." },
  "reminder.failed": {
    title: "Reminder not delivered",
    body: "Call the patient to confirm the appointment.",
  },
  "task.due": { title: "Task due", body: "A task assigned to you is due." },
  "document.expiring": {
    title: "Insurance card expiring",
    body: "A patient's insurance card is about to expire. Open Pulse to see whose.",
  },
  "finance.preauth_expiring": {
    title: "Pre-authorisation expiring",
    body: "An insurance pre-authorisation is about to expire. Open Pulse to see which.",
  },
  "finance.denial_deadline": {
    title: "Denial deadline close",
    body: "A denied claim is close to its resubmission deadline. Open Pulse to see which.",
  },
  "waitlist.booked": {
    title: "Waiting list",
    body: "A waiting-list patient took an offered slot.",
  },
  "inbox.emergency": {
    title: "Message needs attention now",
    body: "A patient message may be urgent. Open the conversation.",
  },
  "ai.insights_ready": {
    title: "AI report ready",
    body: "The weekly AI reply-quality report is ready.",
  },
  escalation: {
    title: "Conversation not picked up",
    body: "A conversation has no owner. Please take it.",
  },
  // The "send me a test" button in Settings > Notifications.
  test: { title: "Test notification", body: "Push notifications are working on this device." },
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const cleanId = (v: string | null | undefined) => (v && UUID.test(v) ? v.toLowerCase() : null);

/** The same-origin page a notification for this event should open. Only validated UUIDs reach the URL. */
export function pushUrl(event: string, ids: PushIds): string {
  const conversation = cleanId(ids.conversation_id);
  const enquiry = cleanId(ids.enquiry_id);
  switch (event) {
    case "inbox.message":
    case "inbox.assigned":
    case "inbox.mention":
    case "inbox.emergency":
    case "escalation":
      return conversation ? `/inbox?c=${conversation}` : "/inbox";
    case "sla.breach":
      return enquiry ? `/enquiries?enquiry=${enquiry}` : "/enquiries";
    case "reminder.failed":
    case "task.due":
      return "/tasks";
    case "document.expiring":
      return cleanId(ids.task_id) ? "/tasks" : "/notifications";
    case "waitlist.booked":
      return "/front-desk";
    case "ai.insights_ready":
      return "/reports/ai-quality";
    case "finance.preauth_expiring":
      return "/finance/preauth";
    case "finance.denial_deadline":
      return "/finance/denials";
    case "test":
      return "/settings/notifications";
    default:
      return "/notifications";
  }
}

export function buildPushPayload(event: string, ids: PushIds = {}): PushPayload | null {
  if (event !== "test" && !getEvent(event)) return null;
  const text = GENERIC[event];
  if (!text) return null;
  const clean: PushIds = {
    conversation_id: cleanId(ids.conversation_id),
    task_id: cleanId(ids.task_id),
    enquiry_id: cleanId(ids.enquiry_id),
    appointment_id: cleanId(ids.appointment_id),
  };
  const anchor =
    clean.conversation_id ?? clean.task_id ?? clean.enquiry_id ?? clean.appointment_id ?? "general";
  return {
    v: 1,
    event,
    title: text.title,
    body: text.body,
    url: pushUrl(event, clean),
    tag: `${event}:${anchor}`,
    ids: clean,
  };
}

/** Generic e-mail subject and sentence for an event (links only, no names or message text). */
export function genericEmail(event: string): { subject: string; sentence: string } | null {
  const text = GENERIC[event];
  return text ? { subject: text.title, sentence: text.body } : null;
}
