import type { AdminClient } from "@/lib/supabase/admin";

/**
 * First touch by reply: a staff member's WhatsApp message that actually reached WhatsApp stops the
 * SLA clock of the contact's open enquiries. Kept free of `server-only` and event listeners because
 * the outbound job handler (a different process from the server actions) calls it directly.
 */

/** Only a person's own message counts: not a bot or flow (no sender), a campaign, or a reaction. */
export function countsAsFirstTouch(message: {
  sent_by_user_id: string | null;
  campaign_recipient_id: string | null;
}, specType: string): boolean {
  return !!message.sent_by_user_id && !message.campaign_recipient_id && specType !== "reaction";
}

/** Sets first_touch_at on the contact's open, untouched enquiries. Idempotent: a touched one is left alone. */
export async function markContactEnquiriesTouched(
  admin: AdminClient,
  orgId: string,
  contactId: string,
  at: Date = new Date(),
): Promise<number> {
  const { data, error } = await admin
    .from("enquiries")
    .update({ first_touch_at: at.toISOString() })
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .is("deleted_at", null)
    .is("first_touch_at", null)
    .select("id");
  if (error) throw new Error(`first touch update failed (${error.code ?? "unknown"})`);
  return data?.length ?? 0;
}
