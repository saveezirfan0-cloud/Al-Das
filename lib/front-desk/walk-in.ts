/**
 * Walk-in registration (pure): validates the desk form.
 *
 * Phase E: a walk-in may have no phone at all, or a number from another country typed with its country code (E.164 via
 * libphonenumber). The box that says the patient agrees to be contacted on WhatsApp is un-ticked by default and is a real
 * choice: without it nothing is sent to the patient on WhatsApp (a new record is marked `whatsapp_declined_at`, which
 * appointment messages, waiting-list offers and desk messages respect). The promotions box is separate and needs the
 * WhatsApp agreement first (marketing needs its own opt-in).
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";

import { normalizePhone } from "@/lib/phone";

export const WALK_IN_LANGUAGES = ["en", "ar", "other"] as const;

export const walkInSchema = z.object({
  /** Optional: blank means "no phone" (the patient has none, or will not give it). */
  phone: z.string().trim().max(30).default(""),
  name: z.string().trim().min(2, "Enter the patient's name.").max(120),
  language: z.enum(WALK_IN_LANGUAGES).default("en"),
  /** The patient agrees to be contacted on WhatsApp about their appointments and care. Off unless ticked. */
  consent_contact: z.boolean().default(false),
  /** Optional and separate: marketing messages (only together with the WhatsApp agreement). */
  consent_promotions: z.boolean().default(false),
  /** Put the patient on today's board right away. */
  add_to_today: z.boolean().default(false),
  locationId: z.string().uuid().optional(),
  specialistId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
});

export type WalkInInput = z.input<typeof walkInSchema>;
export type WalkInData = z.output<typeof walkInSchema>;

/** "Layla Al Example" -> first "Layla", last "Al Example". A single word is a first name. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/** UAE mobile numbers: +971 5x xxx xxxx (50, 52, 54, 55, 56, 58). Landlines cannot receive WhatsApp. */
const UAE_MOBILE = /^\+9715[024568]\d{7}$/;

export type WalkInPhone =
  | { ok: true; e164: null }
  | { ok: true; e164: string; country: string | null; uaeMobile: boolean }
  | { ok: false; error: string };

/**
 * The desk's phone rule. Blank is allowed (no phone). A UAE number must be a mobile; any other country's number must be
 * a valid number for that country (typed with + or 00 and its country code). Nothing is guessed.
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

/** E.164 of a valid walk-in number, or null (blank or invalid). */
export function walkInPhone(raw: string): string | null {
  const d = walkInPhoneDecision(raw);
  return d.ok ? d.e164 : null;
}

export type WalkInConsentPlan = {
  /** Mark the record so nothing goes to the patient on WhatsApp (new records only; see below). */
  declineWhatsApp: boolean;
  /** Clear an earlier refusal and record the agreement on the timeline. */
  recordWhatsAppConsent: boolean;
  /** Marketing opt-in to store (needs the WhatsApp agreement and a number). */
  promotions: boolean;
};

/**
 * What the walk-in form changes about messaging. A NEW record without the tick is marked "no WhatsApp". An EXISTING
 * patient found by their number keeps what the clinic already knows when the box is left empty: the box is unticked by
 * default, so an empty box is not taken as the patient withdrawing an agreement they gave before. A tick always records
 * the agreement (and clears an earlier refusal). Without a phone there is nothing to agree to.
 */
export function walkInConsentPlan(input: {
  created: boolean;
  hasPhone: boolean;
  consentContact: boolean;
  consentPromotions: boolean;
}): WalkInConsentPlan {
  const agreed = input.hasPhone && input.consentContact;
  return {
    declineWhatsApp: input.created && input.hasPhone && !input.consentContact,
    recordWhatsAppConsent: agreed,
    promotions: agreed && input.consentPromotions,
  };
}

/** Stored contact language: en / ar, or nothing for "other" (the desk can fill it in later). */
export function storedLanguage(language: (typeof WALK_IN_LANGUAGES)[number]): string | null {
  return language === "other" ? null : language;
}
