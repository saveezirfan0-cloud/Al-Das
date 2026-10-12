/**
 * Walk-in registration (pure): validates the desk form. Consent is not optional: the box that says the patient
 * agrees to be contacted on WhatsApp about their care must be ticked before anything is saved, and the optional
 * promotions box is a separate, un-ticked-by-default choice (marketing needs its own opt-in).
 */
import { z } from "zod";

import { normalizePhone } from "@/lib/phone";

export const WALK_IN_LANGUAGES = ["en", "ar", "other"] as const;

export const walkInSchema = z.object({
  phone: z.string().trim().min(5, "Enter the patient's mobile number.").max(30),
  name: z.string().trim().min(2, "Enter the patient's name.").max(120),
  language: z.enum(WALK_IN_LANGUAGES).default("en"),
  /** Required: the patient agrees to be contacted on WhatsApp about their appointments and care. */
  consent_contact: z.literal(true, {
    error: "Ask the patient to agree to be contacted on WhatsApp.",
  }),
  /** Optional and separate: marketing messages. */
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

export function walkInPhone(raw: string): string | null {
  return normalizePhone(raw)?.e164 ?? null;
}

/** Stored contact language: en / ar, or nothing for "other" (the desk can fill it in later). */
export function storedLanguage(language: (typeof WALK_IN_LANGUAGES)[number]): string | null {
  return language === "other" ? null : language;
}
