import { z } from "zod";

import { DEFAULT_LIFECYCLE_THRESHOLDS, type LifecycleThresholds } from "@/lib/contacts/lifecycle";

/**
 * Lifecycle thresholds (docs/45 §3), stored in orgs.settings->'lifecycle'. Pure.
 *   newPatientDays  a patient whose first visit is within this many days is "new" (default 90).
 *   activeMonths    a patient whose last visit is within this many months is "active", older is "lapsed" (default 18).
 * The SQL view v_contact_lifecycle reads the same keys with the same defaults (parity-tested).
 */
export const lifecycleSettingsSchema = z.object({
  newPatientDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(DEFAULT_LIFECYCLE_THRESHOLDS.newPatientDays),
  activeMonths: z.number().int().min(1).max(60).default(DEFAULT_LIFECYCLE_THRESHOLDS.activeMonths),
});

export type LifecycleSettings = z.infer<typeof lifecycleSettingsSchema>;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Reads the thresholds; anything unreadable falls back to the defaults. */
export function readLifecycleSettings(orgSettings: unknown): LifecycleThresholds {
  const parsed = lifecycleSettingsSchema.safeParse(asObject(orgSettings).lifecycle ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_LIFECYCLE_THRESHOLDS };
}

/** The org settings with the lifecycle block replaced (every other key kept). */
export function writeLifecycleSettings(
  orgSettings: unknown,
  next: LifecycleSettings,
): Record<string, unknown> {
  return { ...asObject(orgSettings), lifecycle: lifecycleSettingsSchema.parse(next) };
}
