/**
 * Message status ladder. Mirrors app.message_status_rank / app.guard_message_status
 * in supabase/migrations/*_inbox.sql so the rule is unit-testable without a database.
 */
export const MESSAGE_STATUSES = [
  "received",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 9,
};

export function isMessageStatus(value: string): value is MessageStatus {
  return (MESSAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * The status a row ends up with when `next` is applied on top of `current`.
 * Forward only; 'failed' is terminal; 'failed' after 'read' is ignored.
 */
export function nextMessageStatus(current: MessageStatus, next: MessageStatus): MessageStatus {
  if (current === next) return current;
  if (current === "failed") return current;
  if (next === "failed") return current === "read" ? current : next;
  return RANK[next] > RANK[current] ? next : current;
}

/** Meta webhook status strings → our ladder. */
export function fromWebhookStatus(status: string): MessageStatus | null {
  switch (status) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return status;
    case "deleted":
    case "warning":
      return null; // informational; not part of the ladder
    default:
      return null;
  }
}
