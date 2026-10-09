/**
 * Reply / booking attribution for recall sends (replaces Make scenario "Chronic Update" and its Sanoflow webhook hop).
 * Only the NEWEST open send of the contact is credited (OQ-22) — Make marked every row for a phone.
 */
import { DEFAULT_BOOKING_ATTRIBUTION_DAYS, DEFAULT_REPLY_ATTRIBUTION_DAYS } from "@/lib/recall/types";

export type OpenSend = { id: string; sent_at: string; replied_at: string | null; booked_at: string | null; status: string };

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

export function isBookingButton(text: string | null | undefined, extra: string[] = []): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t !== "" && [...BOOKING_BUTTONS, ...extra.map((x) => x.toLowerCase())].includes(t);
}
