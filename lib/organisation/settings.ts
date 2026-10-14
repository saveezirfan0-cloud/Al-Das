import { z } from "zod";

import { DEFAULT_STAFF_EXPIRY_LEAD_DAYS } from "@/lib/organisation/expiry";

/**
 * Organisation (Phase C) settings, stored in orgs.settings->'organisation'. Pure.
 *   expiry_lead_days  days before a visa or licence expires that the daily reminder is raised (default 60).
 */
export const organisationSettingsSchema = z.object({
  expiry_lead_days: z.number().int().min(1).max(180).default(DEFAULT_STAFF_EXPIRY_LEAD_DAYS),
});

export type OrganisationSettings = z.infer<typeof organisationSettingsSchema>;
export const DEFAULT_ORGANISATION_SETTINGS: OrganisationSettings = organisationSettingsSchema.parse(
  {},
);

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Reads the settings; anything unreadable falls back to the defaults. */
export function readOrganisationSettings(orgSettings: unknown): OrganisationSettings {
  const parsed = organisationSettingsSchema.safeParse(asObject(orgSettings).organisation ?? {});
  return parsed.success ? parsed.data : DEFAULT_ORGANISATION_SETTINGS;
}

/** The org settings with the organisation block replaced (every other key kept). */
export function writeOrganisationSettings(
  orgSettings: unknown,
  next: OrganisationSettings,
): Record<string, unknown> {
  return { ...asObject(orgSettings), organisation: organisationSettingsSchema.parse(next) };
}
