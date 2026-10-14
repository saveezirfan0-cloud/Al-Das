/**
 * "No WhatsApp" for a patient who did not agree at the desk (Phase E, pure).
 *
 * `contacts.whatsapp_declined_at` is set when a walk-in is registered with a number but without the WhatsApp tick. While it
 * is set, appointment messages (reminders, confirmations, moves, cancellations), waiting-list offers and the desk's
 * location / running-late messages are not queued for that person. Null means no refusal is recorded (every patient
 * before Phase E), so nothing changes for them.
 */
export const WHATSAPP_DECLINED_ERROR =
  "The patient has not agreed to WhatsApp messages (registered at the desk without the WhatsApp tick).";

/** Reminder exclusion reason stored on appointment_reminders.exclusion_reason. */
export const WHATSAPP_DECLINED_REASON = "no_whatsapp_consent";

export function whatsappDeclined(
  contact: { whatsapp_declined_at?: string | null } | null | undefined,
): boolean {
  return !!contact?.whatsapp_declined_at;
}
