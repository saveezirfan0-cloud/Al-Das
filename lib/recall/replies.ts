/**
 * Reply / booking attribution for recall sends (replaces Make scenario "Chronic Update" and its Sanoflow webhook hop).
 * Only the NEWEST open send of the contact is credited (OQ-22) — Make marked every row for a phone.
 */
import { DEFAULT_BOOKING_ATTRIBUTION_DAYS, DEFAULT_REPLY_ATTRIBUTION_DAYS } from "@/lib/recall/types";

export type OpenSend = { id: string; sent_at: string; replied_at: string | null; booked_at: string | null; status: string; programme_id?: string };

export const BOOKING_BUTTONS = ["book now", "book", "book an appointment", "yes, book"];

const DAY = 86_400_000;

export function pickReplyTarget(sends: OpenSend[], at: Date, days = DEFAULT_REPLY_ATTRIBUTION_DAYS): OpenSend | null {
  const open = sends
    .filter((s) => s.replied_at === null && ["sent", "delivered", "read"].includes(s.status) && new Date(s.sent_at) <= at && at.getTime() - new Date(s.sent_at).getTime() <= days * DAY)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  return open[0] ?? null;
}

export function pickBookingTarget(sends: OpenSend[], at: Date, days = DEFAULT_BOOKING_ATTRIBUTION_DAYS): OpenSend | null {
  const open = sends
    .filter((s) => s.booked_at === null && ["sent", "delivered", "read"].includes(s.status) && new Date(s.sent_at) <= at && at.getTime() - new Date(s.sent_at).getTime() <= days * DAY)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  return open[0] ?? null;
}

/** Quick-reply button text → recall outcome (replaces the Make "Birthday Offer Update" / "Chronic Update" webhook hops). */
export const DEFAULT_BUTTON_OUTCOMES: Record<string, string> = {
  "book now": "wants_booking",
  book: "wants_booking",
  "book an appointment": "wants_booking",
  "yes, book": "wants_booking",
  "claim offer": "offer_redeemed",
  "claim my offer": "offer_redeemed",
  "redeem offer": "offer_redeemed",
  "not interested": "declined",
  stop: "declined",
};

/** `overrides` comes from the programme's config.button_outcomes; they win over the defaults. */
export function outcomeForButton(text: string | null | undefined, overrides: Record<string, string> = {}): string | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const merged = { ...DEFAULT_BUTTON_OUTCOMES, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v])) };
  return merged[t] ?? null;
}

export function isBookingButton(text: string | null | undefined, extra: string[] = []): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t !== "" && [...BOOKING_BUTTONS, ...extra.map((x) => x.toLowerCase())].includes(t);
}
