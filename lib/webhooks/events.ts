import type { DomainEventName } from "@/lib/events/emit";

/**
 * Events an endpoint can subscribe to. Every entry must be a real DomainEventName (the compiler
 * checks it), so adding an event to the emitter and listing it here is all it takes to expose it.
 * Phases 5-8 extend the list (enquiry.*, campaign.*).
 */
export const WEBHOOK_EVENTS = [
  { name: "conversation.opened", label: "Conversation opened", description: "A patient started or reopened a conversation" },
  { name: "conversation.closed", label: "Conversation closed", description: "A conversation was closed by staff or automatically" },
  { name: "conversation.waiting", label: "Conversation waiting", description: "A conversation moved to Waiting" },
  { name: "conversation.assigned", label: "Conversation assigned", description: "A conversation was assigned to a person or team" },
  { name: "message.received", label: "Message received", description: "A patient sent a message (ids only, no text)" },
  { name: "message.sent", label: "Message sent", description: "An outbound message was handed to WhatsApp" },
  { name: "message.failed", label: "Message failed", description: "An outbound message could not be delivered" },
  { name: "contact.created", label: "Contact created", description: "A new contact was created" },
  { name: "contact.stop_marketing", label: "Contact opted out of marketing", description: "A contact stopped receiving marketing messages" },
  { name: "appointment.created", label: "Appointment created", description: "An appointment was booked in Pulse or synced from Unite (ids only)" },
  { name: "appointment.updated", label: "Appointment changed", description: "An appointment was rescheduled or edited" },
  { name: "appointment.status_changed", label: "Appointment status changed", description: "An appointment was confirmed, cancelled, completed or marked no-show" },
  { name: "channel.quality_changed", label: "Number quality changed", description: "A WhatsApp number's quality rating changed" },
  { name: "template.status_changed", label: "Template status changed", description: "A WhatsApp template was approved, rejected or paused" },
] as const satisfies ReadonlyArray<{ name: DomainEventName; label: string; description: string }>;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]["name"];
export const WEBHOOK_EVENT_NAMES: readonly string[] = WEBHOOK_EVENTS.map((e) => e.name);

/** Sent by the "Send test" button; always deliverable, never subscribable. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export function isWebhookEvent(name: string): name is WebhookEventName {
  return WEBHOOK_EVENT_NAMES.includes(name);
}
