/**
 * Moving a chat to a new contact (Sanoflow parity G11): who is actually writing in the chat. Pure; server-side only
 * (pulls in the phone-number library).
 *
 * The new contact takes over the old contact's MAIN phone and BSUID. That is only right when the chat really runs on
 * that identity: a chat that came in on one of the old contact's alternate numbers (contact_phones) would otherwise
 * hand the main number to the wrong person. The sender is read from the raw `from` of the latest inbound message.
 * SQL repeats the same check (public.unlink_conversation_contact).
 */
import { looksLikeBsuid, waIdToE164 } from "@/lib/whatsapp/phone";

export type SenderCheck = { ok: true } | { ok: false; error: string };

export const SENDER_ERRORS = {
  none: "Nobody has written in this chat yet, so it cannot be moved. Wait for the person to write.",
  other:
    "This chat runs on a different number from the contact's main number (for example an alternate number). It cannot be moved; edit the contact's numbers instead.",
} as const;

/** True when the latest inbound sender (`from`) is the contact's main WhatsApp identity. */
export function checkChatSender(
  from: string | null | undefined,
  contact: { phone_e164: string | null; wa_bsuid: string | null },
): SenderCheck {
  const raw = typeof from === "string" ? from.trim() : "";
  if (!raw) return { ok: false, error: SENDER_ERRORS.none };
  if (contact.wa_bsuid && raw === contact.wa_bsuid) return { ok: true };
  if (!looksLikeBsuid(raw)) {
    const phone = waIdToE164(raw);
    if (phone && contact.phone_e164 && phone === contact.phone_e164) return { ok: true };
  }
  return { ok: false, error: SENDER_ERRORS.other };
}

/** The raw sender of an inbound message payload (Meta's `from`), or null. */
export function senderOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const from = (payload as { from?: unknown }).from;
  return typeof from === "string" && from ? from : null;
}
