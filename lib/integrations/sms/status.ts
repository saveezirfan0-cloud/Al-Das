/**
 * SMS delivery status ladder (pure). Mirrors the WhatsApp rule: a status only moves forward, a late "sent" can never undo
 * "delivered", and a failure is final unless the message had already been delivered.
 */
export const SMS_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

const RANK: Record<SmsStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 9,
  failed: 9,
};

export function isSmsStatus(value: string): value is SmsStatus {
  return (SMS_STATUSES as readonly string[]).includes(value);
}

/** A Twilio-style MessageStatus mapped onto our ladder (null = informational, ignore). */
export function fromProviderStatus(status: string): SmsStatus | null {
  switch (status.toLowerCase()) {
    case "accepted":
    case "scheduled":
    case "queued":
      return "queued";
    case "sending":
      return "sending";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
      return "undelivered";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

export function nextSmsStatus(current: SmsStatus, next: SmsStatus): SmsStatus {
  if (current === next) return current;
  if (current === "failed" || current === "undelivered" || current === "delivered") return current;
  if (RANK[next] === 9) return next;
  return RANK[next] > RANK[current] ? next : current;
}

/** The stored statuses a row may be in for `next` to be applied: lets the database do the forward-only update atomically. */
export function previousStatusesFor(next: SmsStatus): SmsStatus[] {
  return SMS_STATUSES.filter((s) => nextSmsStatus(s, next) === next && s !== next);
}
