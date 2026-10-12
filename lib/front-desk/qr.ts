/**
 * The desk QR (pure): a wa.me link that opens a WhatsApp chat with the clinic's number and a ready-typed
 * registration message. The text is the patient's own words to send; it carries no personal data.
 */
import { isE164 } from "@/lib/phone";

export const MAX_PREFILL_LENGTH = 200;

export function whatsappDeskLink(phoneE164: string, message: string): string | null {
  if (!isE164(phoneE164)) return null;
  const text = message.trim().slice(0, MAX_PREFILL_LENGTH);
  const digits = phoneE164.slice(1);
  return text
    ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
    : `https://wa.me/${digits}`;
}

/** Registration text by language; Arabic falls back to English when no Arabic text is set. */
export function registrationMessage(
  settings: { registration_message_en: string; registration_message_ar: string },
  language: "en" | "ar",
): string {
  return language === "ar"
    ? settings.registration_message_ar || settings.registration_message_en
    : settings.registration_message_en;
}
