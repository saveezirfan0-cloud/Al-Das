import { z } from "zod";

/**
 * Enquiry settings, stored in orgs.settings->'enquiries'. Pipelines and stages are tables;
 * everything scalar lives here. Same pattern as lib/appointments/settings.ts.
 */
export const SLA_HOUR_OPTIONS = [1, 2, 4, 8] as const;

export const enquirySettingsSchema = z.object({
  /**
   * An Open enquiry may sit in one stage for this many hours before its assignee is alerted
   * (null = no SLA). Alerts fire once per stage visit.
   */
  sla_hours: z
    .number()
    .int()
    .refine((n) => (SLA_HOUR_OPTIONS as readonly number[]).includes(n))
    .nullable()
    .default(null),
  notifications: z
    .object({
      /** Tell a user when an enquiry is assigned to them by someone else. */
      on_assigned: z.boolean().default(true),
      /** Tell the assignee when someone else moves their enquiry to another stage. */
      on_stage_change: z.boolean().default(false),
      /** Tell the assignee (or enquiries.manage holders when unassigned) when the SLA is breached. */
      on_sla_breach: z.boolean().default(true),
      /** Tell enquiries.manage holders about new unassigned enquiries. */
      on_new_unassigned: z.boolean().default(false),
    })
    .default({
      on_assigned: true,
      on_stage_change: false,
      on_sla_breach: true,
      on_new_unassigned: false,
    }),
  assignment: z
    .object({
      /**
       * manual: leave unassigned. creator: assign to whoever created it.
       * round_robin: rotate through the pipeline's default team (unassigned when it has none).
       */
      mode: z.enum(["manual", "creator", "round_robin"]).default("manual"),
    })
    .default({ mode: "manual" }),
});

export type EnquirySettings = z.infer<typeof enquirySettingsSchema>;

export const DEFAULT_ENQUIRY_SETTINGS: EnquirySettings = enquirySettingsSchema.parse({});

/** Reads org.settings (jsonb) → EnquirySettings, tolerating missing or invalid values. */
export function readEnquirySettings(orgSettings: unknown): EnquirySettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).enquiries
      : undefined;
  const parsed = enquirySettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_ENQUIRY_SETTINGS;
}

/** Returns a new org.settings object with the enquiries section replaced. */
export function writeEnquirySettings(
  orgSettings: unknown,
  next: EnquirySettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.enquiries = next;
  return base;
}
