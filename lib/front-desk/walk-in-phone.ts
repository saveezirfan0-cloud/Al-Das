/**
 * The walk-in phone rule (Phase E, pure). Its own module, without zod, so the walk-in dialog can check the number as it
 * is typed without pulling the form schema into the desk's browser bundle. lib/front-desk/walk-in.ts re-exports it.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { normalizePhone } from "@/lib/phone";

/** UAE mobile numbers: +971 5x xxx xxxx (50, 52, 54, 55, 56, 58). Landlines cannot receive WhatsApp. */
const UAE_MOBILE = /^\+9715[024568]\d{7}$/;

export type WalkInPhone =
  | { ok: true; e164: null }
  | { ok: true; e164: string; country: string | null; uaeMobile: boolean }
  | { ok: false; error: string };

/**
 * The desk's phone rule. Blank is allowed (no phone). A UAE number must be a mobile; any other country's number must be
 * possible for that country (typed with + or 00 and its country code). Nothing is guessed.
 */
export function walkInPhoneDecision(raw: string | null | undefined): WalkInPhone {
  const typed = (raw ?? "").trim();
  if (!typed) return { ok: true, e164: null };
  const n = normalizePhone(typed);
  if (!n)
    return {
      ok: false,
      error:
        "That does not look like a phone number. Include the country code (+44 …) if it is not a UAE number, or leave it blank.",
    };
  if (n.e164.startsWith("+971")) {
    if (!UAE_MOBILE.test(n.e164))
      return {
        ok: false,
        error:
          "That is not a UAE mobile number (050, 052, 054, 055, 056 or 058). Leave it blank if the patient has no mobile.",
      };
    return { ok: true, e164: n.e164, country: "AE", uaeMobile: true };
  }
  // Another country: a number that can exist there (length and country code), the same test the rest of Pulse uses.
  // Stricter "valid number" metadata would refuse reserved ranges such as the +44 7700 900xxx numbers of the training
  // workspace, so it is not used.
  const parsed = parsePhoneNumberFromString(n.e164);
  if (!parsed || !parsed.isPossible())
    return {
      ok: false,
      error: "That number is not possible for its country. Check the country code and the digits.",
    };
  return { ok: true, e164: parsed.number, country: parsed.country ?? null, uaeMobile: false };
}
