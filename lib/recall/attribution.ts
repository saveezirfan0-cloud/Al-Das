import "server-only";

import {
  outcomeForButton,
  pickBookingTarget,
  pickReplyTarget,
  type OpenSend,
} from "@/lib/recall/replies";
import {
  DEFAULT_BOOKING_ATTRIBUTION_DAYS,
  DEFAULT_REPLY_ATTRIBUTION_DAYS,
} from "@/lib/recall/types";
import type { AdminClient } from "@/lib/supabase/admin";

async function days(
  admin: AdminClient,
  orgId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const { data } = await admin.rpc("clinical_setting_num", { p_org: orgId, p_key: key });
  return typeof data === "number" && data > 0 ? data : fallback;
}

async function openSends(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<OpenSend[]> {
  const { data } = await admin
    .from("recall_sends")
    .select("id, sent_at, replied_at, booked_at, status, programme_id")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(20);
  return (data ?? []).flatMap((s) =>
    s.sent_at === null ? [] : [{ ...s, sent_at: s.sent_at } satisfies OpenSend],
  );
}

/** Patient answered a recall message: credit the newest open send. Button "Book now" also records the intent. */
export async function attributeInboundReply(
  admin: AdminClient,
  input: {
    orgId: string;
    contactId: string;
    messageId: string;
    body: string | null;
    kind: string;
    at?: Date;
  },
): Promise<{ attributed: boolean; wantsBooking: boolean }> {
  const at = input.at ?? new Date();
  const target = pickReplyTarget(
    await openSends(admin, input.orgId, input.contactId),
    at,
    await days(admin, input.orgId, "recall_reply_attribution_days", DEFAULT_REPLY_ATTRIBUTION_DAYS),
  );
  if (!target) return { attributed: false, wantsBooking: false };
  let outcome: string | null = null;
  if (input.kind === "button") {
    const { data: prog } = target.programme_id
      ? await admin
          .from("recall_programmes")
          .select("config")
          .eq("id", target.programme_id)
          .maybeSingle()
      : { data: null };
    const overrides = ((prog?.config as Record<string, unknown> | undefined)?.button_outcomes ??
      {}) as Record<string, string>;
    outcome = outcomeForButton(input.body, overrides);
  }
  const wantsBooking = outcome === "wants_booking";
  await admin
    .from("recall_sends")
    .update({
      replied_at: at.toISOString(),
      reply_message_id: input.messageId,
      ...(outcome ? { outcome } : {}),
    })
    .eq("id", target.id)
    .is("replied_at", null);
  return { attributed: true, wantsBooking };
}

/** An appointment was created for a contact: credit the newest open send (replaces Make's "Booked" status call). */
export async function attributeBooking(
  admin: AdminClient,
  input: { orgId: string; contactId: string; appointmentId: string | null; at?: Date },
): Promise<boolean> {
  const at = input.at ?? new Date();
  const target = pickBookingTarget(
    await openSends(admin, input.orgId, input.contactId),
    at,
    await days(
      admin,
      input.orgId,
      "recall_booking_attribution_days",
      DEFAULT_BOOKING_ATTRIBUTION_DAYS,
    ),
  );
  if (!target) return false;
  await admin
    .from("recall_sends")
    .update({
      booked_at: at.toISOString(),
      appointment_id: input.appointmentId,
      follow_up_status: "booked",
    })
    .eq("id", target.id)
    .is("booked_at", null);
  return true;
}
