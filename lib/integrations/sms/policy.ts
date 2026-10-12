import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/**
 * Who may be sent an SMS, and when (pure; every input is a parameter so each rule is unit-tested).
 *
 * The SMS fallback exists for ONE job: an appointment reminder that WhatsApp could not deliver. That is a transactional message,
 * so a marketing opt-out does not stop it, but an SMS opt-out does. The "marketing" class is modelled so the rule is written
 * down and tested, and nothing sends it yet: marketing needs promotions_opt_in and no stop_marketing.
 */

export type SmsClass = "reminder" | "marketing";

export type SmsSkipReason =
  | "no_phone"
  | "not_sms_capable"
  | "opted_out"
  | "marketing_blocked"
  | "whatsapp_opt_out"
  | "appointment_inactive"
  | "appointment_started";

export type SmsDecision = { allow: true } | { allow: false; reason: SmsSkipReason };

export type SmsRecipient = {
  phone_e164: string | null;
  sms_opt_out_at: string | null;
  promotions_opt_in: boolean | null;
  stop_marketing: boolean | null;
};

/** WhatsApp errors after which a text message would go against the person's wish (131050 = they stopped business messages). */
export const NO_FALLBACK_WHATSAPP_CODES: ReadonlySet<number> = new Set([131050]);

/** A mobile (or ambiguous mobile/fixed) number. A landline cannot receive an SMS reminder. */
export function isSmsCapablePhone(e164: string | null | undefined): boolean {
  if (!e164) return false;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed?.isValid()) return false;
  const type = parsed.getType();
  return type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";
}

const INACTIVE = new Set(["cancelled", "completed", "no_show"]);

export function smsDecision(input: {
  messageClass: SmsClass;
  recipient: SmsRecipient;
  whatsappErrorCode?: number | null;
  appointment?: { status: string; startsAt: string } | null;
  now: Date;
}): SmsDecision {
  const r = input.recipient;
  if (!r.phone_e164) return { allow: false, reason: "no_phone" };
  if (!isSmsCapablePhone(r.phone_e164)) return { allow: false, reason: "not_sms_capable" };
  if (r.sms_opt_out_at) return { allow: false, reason: "opted_out" };
  if (input.whatsappErrorCode != null && NO_FALLBACK_WHATSAPP_CODES.has(input.whatsappErrorCode))
    return { allow: false, reason: "whatsapp_opt_out" };
  if (input.messageClass === "marketing" && (!r.promotions_opt_in || r.stop_marketing))
    return { allow: false, reason: "marketing_blocked" };
  if (input.appointment) {
    if (INACTIVE.has(input.appointment.status))
      return { allow: false, reason: "appointment_inactive" };
    if (new Date(input.appointment.startsAt).getTime() <= input.now.getTime())
      return { allow: false, reason: "appointment_started" };
  }
  return { allow: true };
}
