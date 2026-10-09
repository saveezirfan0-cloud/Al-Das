import "server-only";

import { loadClinicalSettings } from "@/lib/clinical/engine";
import { pickSendForBooking, pickSendForReply, type OpenSend } from "@/lib/clinical/recall";
import type { AdminClient } from "@/lib/supabase/admin";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Replaces Make's "Chronic Update" webhook (Status = Replied / Booked, matched by phone number only,
 * which updated every recall row for a number, OQ-22). Here the match is the patient's most recent
 * open recall inside a signed-off window, one row at a time. Called for domain events from the flow
 * event job; it only reads and updates recall_sends.
 */
export async function attributeRecallEvent(
  admin: AdminClient,
  ev: { org_id: string; name: string; payload: Record<string, unknown>; at: string },
): Promise<{ replied: number; booked: number }> {
  const out = { replied: 0, booked: 0 };
  const contactId = str(ev.payload.contact_id);
  if (!contactId) return out;
  const isReply = ev.name === "message.received" && ev.payload.kind !== "reaction";
  const isBooking = ev.name === "appointment.created";
  if (!isReply && !isBooking) return out;

  const { data } = await admin
    .from("recall_sends")
    .select("id, sent_at, replied_at, booked_at")
    .eq("org_id", ev.org_id)
    .eq("contact_id", contactId)
    .in("status", ["sent", "delivered", "read"])
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(10);
  if (!data?.length) return out;
  const sends: OpenSend[] = data.map((r) => ({
    id: r.id,
    sentAt: r.sent_at,
    repliedAt: r.replied_at,
    bookedAt: r.booked_at,
  }));

  const settings = await loadClinicalSettings(admin, ev.org_id);
  const at = new Date(ev.at);
  if (isReply) {
    const pick = pickSendForReply(sends, at, settings.num("recall_reply_attribution_days"));
    if (pick) {
      const { error } = await admin
        .from("recall_sends")
        .update({ replied_at: ev.at, reply_message_id: str(ev.payload.message_id) })
        .eq("id", pick.id)
        .is("replied_at", null);
      if (!error) out.replied++;
    }
  }
  if (isBooking) {
    const pick = pickSendForBooking(sends, at, settings.num("recall_booking_attribution_days"));
    if (pick) {
      const { error } = await admin
        .from("recall_sends")
        .update({
          booked_at: ev.at,
          appointment_id: str(ev.payload.appointment_id),
          follow_up_status: "booked",
        })
        .eq("id", pick.id)
        .is("booked_at", null);
      if (!error) out.booked++;
    }
  }
  return out;
}
