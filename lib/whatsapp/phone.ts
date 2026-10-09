import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Meta's `wa_id` is the phone in international format without '+' (e.g. 9715xxxxxxx).
 * Username (BSUID) users may have no phone at all; then `wa_id` is not numeric.
 */
export function waIdToE164(waId: string | null | undefined): string | null {
  if (!waId) return null;
  const digits = waId.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15 || digits !== waId.replace(/^\+/, "")) return null;
  const parsed = parsePhoneNumberFromString("+" + digits);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** Any user input → E.164, or null when it is not a possible number. Default region UAE. */
export function toE164(
  input: string | null | undefined,
  defaultCountry: "AE" | string = "AE",
): string | null {
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry as "AE");
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** E.164 → Meta recipient (digits only). */
export function e164ToWaId(phone: string): string {
  return phone.replace(/^\+/, "");
}

/** Redacted form for logs: +9715•••••12. Never log full numbers (CLAUDE.md rule 9). */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  if (phone.length <= 6) return "•••";
  return `${phone.slice(0, 5)}•••••${phone.slice(-2)}`;
}

/**
 * A BSUID (Meta `user_id`) is an opaque identifier for WhatsApp username users.
 * Treated as a BSUID when it is not a plausible phone number.
 */
export function looksLikeBsuid(value: string | null | undefined): boolean {
  if (!value) return false;
  return waIdToE164(value) === null;
}
