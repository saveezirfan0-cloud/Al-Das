import { createHash } from "node:crypto";

/**
 * Identifier hashing for Meta's Conversions API (pure). Meta wants SHA-256 of a normalised value as lower-case hex:
 *   e-mail   trimmed and lower-cased
 *   phone    digits only, with the country code and no leading zeros or "+"  (E.164 without the plus)
 * A value that cannot be normalised returns null: nothing is sent rather than a hash of junk.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  // one @, something on both sides, a dot in the domain; no spaces
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** Digits of an E.164 number ("+971 50 123 4567" -> "971501234567"). Anything that is not 8 to 15 digits is rejected. */
export function normalizePhoneDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function hashEmail(raw: string | null | undefined): string | null {
  const v = normalizeEmail(raw);
  return v ? sha256Hex(v) : null;
}

export function hashPhone(raw: string | null | undefined): string | null {
  const v = normalizePhoneDigits(raw);
  return v ? sha256Hex(v) : null;
}
