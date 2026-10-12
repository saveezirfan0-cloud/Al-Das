import { z } from "zod";

import { DEFAULT_EXPIRY_LEAD_DAYS } from "@/lib/documents/expiry";

/**
 * Patient-document settings, stored in orgs.settings->'documents'.
 *
 * `enabled` is OFF until an administrator confirms that the storage region has been approved (the data
 * residency question in docs/15_PHASE_16_NOTES.md). While it is off nobody can upload a patient document.
 */
export const documentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Days before an insurance card expires that the reminder (notification and task) is raised. */
  expiry_lead_days: z.number().int().min(1).max(90).default(DEFAULT_EXPIRY_LEAD_DAYS),
  /** Create a follow-up task on the patient when the reminder is raised. */
  expiry_task: z.boolean().default(true),
  confirmed_at: z.string().nullable().default(null),
  confirmed_by: z.string().nullable().default(null),
});

export type DocumentSettings = z.infer<typeof documentSettingsSchema>;
export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = documentSettingsSchema.parse({});

export function readDocumentSettings(orgSettings: unknown): DocumentSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).documents
      : undefined;
  const parsed = documentSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_DOCUMENT_SETTINGS;
}

export function writeDocumentSettings(
  orgSettings: unknown,
  next: DocumentSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.documents = documentSettingsSchema.parse(next);
  return base;
}

/** The phrase an administrator types to switch patient documents on. */
export const DOCUMENTS_CONFIRM_PHRASE = "STORAGE REGION APPROVED";
