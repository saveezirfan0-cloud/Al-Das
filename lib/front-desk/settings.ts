import { z } from "zod";

/**
 * Front desk settings, stored in orgs.settings->'front_desk'. Same pattern as lib/appointments/settings.ts:
 * one Zod schema, a tolerant reader, an immutable writer. Everything that sends a message defaults to OFF.
 */
const templateId = z.string().uuid().nullable().default(null);

export const DEFAULT_REGISTRATION_EN = "Hello, I would like to register as a new patient.";
export const DEFAULT_REGISTRATION_AR = "مرحبا، أود التسجيل كمريض جديد.";

export const frontDeskSettingsSchema = z.object({
  /** Offer a freed slot to the waitlist. Off until the clinic has mapped a template and agreed the wording. */
  offers_enabled: z.boolean().default(false),
  /** Approved template for an offer outside the 24-hour window. Body variables come from variable_map. */
  offer_template_id: templateId,
  /** How long an offer stays open, in minutes. */
  offer_ttl_minutes: z.number().int().min(5).max(240).default(15),
  /** How many people are asked at once. 1 = strictly in order; more = first YES wins. */
  offer_batch_size: z.number().int().min(1).max(5).default(1),
  /** Do not offer a slot that starts sooner than this many minutes from now. */
  offer_min_lead_minutes: z.number().int().min(0).max(1440).default(60),
  /** Templates for the one-tap messages when the 24-hour window is closed. */
  running_late_template_id: templateId,
  location_template_id: templateId,
  /** Minutes after the start time before an expected patient is flagged as late on the board. */
  late_grace_minutes: z.number().int().min(5).max(120).default(15),
  /** Length used when listing the next free slot per doctor on the board. */
  next_slot_minutes: z.number().int().min(10).max(120).default(30),
  /** The WhatsApp number printed on the desk QR (null = first active number). */
  desk_channel_id: z.string().uuid().nullable().default(null),
  registration_message_en: z.string().trim().min(1).max(200).default(DEFAULT_REGISTRATION_EN),
  registration_message_ar: z.string().trim().min(1).max(200).default(DEFAULT_REGISTRATION_AR),
});

export type FrontDeskSettings = z.infer<typeof frontDeskSettingsSchema>;

export const DEFAULT_FRONT_DESK_SETTINGS: FrontDeskSettings = frontDeskSettingsSchema.parse({});

export function readFrontDeskSettings(orgSettings: unknown): FrontDeskSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).front_desk
      : undefined;
  const parsed = frontDeskSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_FRONT_DESK_SETTINGS;
}

export function writeFrontDeskSettings(
  orgSettings: unknown,
  next: FrontDeskSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.front_desk = next;
  return base;
}
