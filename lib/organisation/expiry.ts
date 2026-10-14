/**
 * Visa and licence expiry for staff and doctors (pure; unit-tested). Dates are calendar dates (YYYY-MM-DD) in the
 * clinic's timezone, compared as plain dates (the same day arithmetic as patient documents, lib/documents/expiry.ts).
 * The lead time comes from orgs.settings->'organisation' (lib/organisation/settings.ts), default 60 days.
 */
import { addDays, daysUntil } from "@/lib/documents/expiry";

export const DEFAULT_STAFF_EXPIRY_LEAD_DAYS = 60;

export type ExpiryBadge = {
  state: "none" | "valid" | "soon" | "expired";
  /** Short text for the badge, e.g. "Expires in 12 days". Empty when there is no date. */
  label: string;
  /** Badge variant used by the lists (warning for soon, destructive for expired). */
  tone: "muted" | "success" | "warning" | "destructive";
  days: number | null;
};

/** The badge for one expiry date: expired, soon (within the lead days, today included) or valid. */
export function expiryBadge(
  expiresOn: string | null | undefined,
  today: string,
  leadDays: number = DEFAULT_STAFF_EXPIRY_LEAD_DAYS,
): ExpiryBadge {
  const days = daysUntil(expiresOn, today);
  if (days === null) return { state: "none", label: "", tone: "muted", days: null };
  if (days < 0)
    return {
      state: "expired",
      label: days === -1 ? "Expired yesterday" : `Expired ${-days} days ago`,
      tone: "destructive",
      days,
    };
  if (days <= leadDays) {
    const label =
      days === 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${days} days`;
    return { state: "soon", label, tone: "warning", days };
  }
  return { state: "valid", label: `Valid until ${expiresOn}`, tone: "success", days };
}

/** The worse of several badges (expired before soon before valid before none), for a row with a visa and a licence. */
export function worstBadge(badges: readonly ExpiryBadge[]): ExpiryBadge {
  const rank = { expired: 3, soon: 2, valid: 1, none: 0 } as const;
  return badges.reduce<ExpiryBadge>((worst, b) => (rank[b.state] > rank[worst.state] ? b : worst), {
    state: "none",
    label: "",
    tone: "muted",
    days: null,
  });
}

/** The last date a reminder query must include (today + lead days), or null for a bad date. */
export function reminderHorizon(today: string, leadDays: number): string | null {
  return addDays(today, Math.max(0, Math.floor(leadDays)));
}

export type ExpiringRecord = {
  id: string;
  expires_on: string | null;
  notified_at: string | null;
};

/**
 * The records whose reminder is due today: a valid date within the lead days (or already past) and not yet notified.
 * The caller still claims each one atomically (update … where notified_at is null) before notifying.
 */
export function dueForReminder<T extends ExpiringRecord>(
  rows: readonly T[],
  today: string,
  leadDays: number,
): T[] {
  return rows.filter((r) => {
    if (r.notified_at) return false;
    const days = daysUntil(r.expires_on, today);
    return days !== null && days <= leadDays;
  });
}
