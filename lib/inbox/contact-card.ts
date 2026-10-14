/**
 * Contact card (Sanoflow parity G11): a WhatsApp `contacts` message staff type themselves. Pure; server-side only
 * because it pulls in the phone-number library (kept out of the inbox's first load).
 */
import { toE164 } from "@/lib/whatsapp/phone";
import type { ContactObject } from "@/lib/whatsapp/types";

export type ContactCardInput = { name: string; phone: string; company?: string | null };

/**
 * A WhatsApp contact card that staff type themselves (a doctor's line, another branch, a lab). It is never filled
 * from a patient record, so sharing a card cannot leak another patient's number. The phone must be a valid number;
 * it is sent in E.164.
 */
export function buildContactCard(
  input: ContactCardInput,
): { ok: true; card: ContactObject; label: string } | { ok: false; error: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Enter the name on the card." };
  if (name.length > 200) return { ok: false, error: "The name is too long." };
  const phone = toE164(input.phone.trim());
  if (!phone) return { ok: false, error: "Enter a valid phone number with its country code." };
  const company = input.company?.trim();
  if (company && company.length > 100) return { ok: false, error: "The organisation is too long." };
  const space = name.indexOf(" ");
  const card: ContactObject = {
    name: {
      formatted_name: name,
      first_name: space === -1 ? name : name.slice(0, space),
      ...(space === -1 ? {} : { last_name: name.slice(space + 1) }),
    },
    phones: [{ phone, type: "WORK" }],
    ...(company ? { org: { company } } : {}),
  };
  return { ok: true, card, label: name };
}
