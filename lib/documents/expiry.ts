/**
 * Expiry rules for patient documents (pure; unit-tested). Dates are calendar dates (YYYY-MM-DD) in the
 * clinic's own timezone, compared as plain dates so a UTC server never shifts a card's expiry by a day.
 */
import { isCategory, REMINDER_CATEGORIES, type DocumentCategory } from "@/lib/documents/categories";

export const DEFAULT_EXPIRY_LEAD_DAYS = 14;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses YYYY-MM-DD as a UTC day number, or null when it is not a real date. */
export function dayNumber(date: string | null | undefined): number | null {
  if (!date || !ISO_DATE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    return null;
  return Math.floor(t / 86_400_000);
}

/** Whole days from `today` to `expiresOn` (negative once expired); null without a valid date. */
export function daysUntil(expiresOn: string | null | undefined, today: string): number | null {
  const e = dayNumber(expiresOn);
  const t = dayNumber(today);
  return e === null || t === null ? null : e - t;
}

export type ExpiryState = "none" | "valid" | "expiring" | "expired";

export function expiryState(
  expiresOn: string | null | undefined,
  today: string,
  leadDays: number = DEFAULT_EXPIRY_LEAD_DAYS,
): ExpiryState {
  const days = daysUntil(expiresOn, today);
  if (days === null) return "none";
  if (days < 0) return "expired";
  return days <= leadDays ? "expiring" : "valid";
}

export function expiryLabel(
  expiresOn: string | null | undefined,
  today: string,
  leadDays?: number,
): string {
  const days = daysUntil(expiresOn, today);
  if (days === null) return "";
  const state = expiryState(expiresOn, today, leadDays);
  if (state === "expired") return days === -1 ? "Expired yesterday" : `Expired ${-days} days ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return state === "expiring" ? `Expires in ${days} days` : `Valid until ${expiresOn}`;
}

export type ExpiryCandidate = {
  id: string;
  category: string;
  expires_on: string | null;
  expiry_notified_at: string | null;
};

/**
 * Which documents need the reminder now: a reminder category, an expiry date on or before today + lead,
 * and not already notified. Cards that expired long ago are still reminded once (the first run after
 * an upload), but never repeatedly, because `expiry_notified_at` is set when the reminder is sent.
 */
export function dueForExpiryReminder<T extends ExpiryCandidate>(
  docs: readonly T[],
  today: string,
  leadDays: number = DEFAULT_EXPIRY_LEAD_DAYS,
): T[] {
  return docs.filter((d) => {
    if (d.expiry_notified_at) return false;
    if (!isCategory(d.category) || !REMINDER_CATEGORIES.includes(d.category as DocumentCategory))
      return false;
    const days = daysUntil(d.expires_on, today);
    return days !== null && days <= leadDays;
  });
}

/**
 * When the follow-up task is due: two days before the card expires (06:00 UTC, mid-morning in the Gulf),
 * or right away when that moment has passed. Always returns a real timestamp because tasks require one.
 */
export function expiryTaskDue(expiresOn: string, now: Date): Date {
  const e = dayNumber(expiresOn);
  if (e === null) return now;
  const target = new Date((e - 2) * 86_400_000 + 6 * 3_600_000);
  return target.getTime() > now.getTime() ? target : now;
}

/** An expiry date must be a real date, not before 1990 and not more than 30 years ahead. */
export function validExpiryDate(value: string, today: string): boolean {
  const e = dayNumber(value);
  const t = dayNumber(today);
  if (e === null || t === null) return false;
  return e >= dayNumber("1990-01-01")! && e <= t + 30 * 366;
}

/** YYYY-MM-DD plus a number of days (negative goes back), or null for a date that is not real. */
export function addDays(date: string, days: number): string | null {
  const n = dayNumber(date);
  return n === null ? null : new Date((n + days) * 86_400_000).toISOString().slice(0, 10);
}
