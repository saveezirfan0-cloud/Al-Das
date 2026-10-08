/**
 * Phone helpers. Contacts store E.164 only (CLAUDE.md conventions).
 * Framework-free; shared by the UI, server actions, importers and tests.
 */
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export const DEFAULT_COUNTRY: CountryCode = "AE";

export type NormalizedPhone = { e164: string; country: string | null };

/**
 * Normalises a user- or system-supplied phone to E.164.
 *  - "971-501234567", "00971501234567", "+971 50 123 4567" → +971501234567
 *  - "0501234567" with default country AE → +971501234567
 *  - Returns null when the number is not possible for any region.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = DEFAULT_COUNTRY,
): NormalizedPhone | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Unite exports "971-5xxxxxxx"; Airtable/Excel sometimes prefix with an apostrophe.
  s = s.replace(/^'/, "").replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  // Digits only without a leading + or 0: assume an international number if it
  // starts with the default country's calling code, otherwise a national one.
  if (/^\d+$/.test(s) && !s.startsWith("0")) {
    const withPlus = parsePhoneNumberFromString(`+${s}`);
    if (withPlus?.isPossible()) {
      return { e164: withPlus.number, country: withPlus.country ?? null };
    }
  }
  const parsed = parsePhoneNumberFromString(s, defaultCountry);
  if (!parsed || !parsed.isPossible()) return null;
  return { e164: parsed.number, country: parsed.country ?? null };
}

export function isE164(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\+[1-9][0-9]{6,14}$/.test(value);
}

/** Safe for logs and reports: keeps the country code and the last two digits. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^(\+\d{1,3})(\d+)(\d{2})$/.exec(e164);
  if (!m) return "***";
  return `${m[1]}${"*".repeat(Math.max(3, m[2].length))}${m[3]}`;
}

/** Display form, e.g. +971 50 123 4567. Falls back to the raw value. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
