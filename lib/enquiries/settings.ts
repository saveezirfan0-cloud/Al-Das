import { z } from "zod";

import { ENQUIRY_EVENT_NAMES } from "@/lib/enquiries/constants";

/**
 * Settings → Enquiries scalars, stored in orgs.settings->'enquiries'.
 * Pipelines, stages, assignment rules, custom fields and lookups are tables.
 */
export const SLA_OPTIONS_MINUTES = [5, 10, 15, 30, 60, 120, 240, 480] as const;

export const notificationRuleSchema = z.object({
  id: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  event: z.enum(ENQUIRY_EVENT_NAMES),
  /** Notify the enquiry's assignee. */
  assignee: z.boolean().default(true),
  /** Also notify these users. */
  user_ids: z.array(z.string().uuid()).max(50).default([]),
  /** Also notify every member of this team. */
  team_id: z.string().uuid().nullable().default(null),
  in_app: z.boolean().default(true),
  email: z.boolean().default(false),
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;

export const DEFAULT_SOURCES = [
  "WhatsApp",
  "Phone call",
  "Walk-in",
  "Website",
  "Instagram",
  "Referral",
] as const;

export const enquirySettingsSchema = z.object({
  /** Minutes until an unassigned-or-untouched open enquiry breaches its SLA (null = no SLA). */
  sla_default_minutes: z.number().int().min(1).max(480).nullable().default(null),
  notification_rules: z
    .array(notificationRuleSchema)
    .max(50)
    .default([
      {
        id: "default-assigned",
        enabled: true,
        event: "assigned",
        assignee: true,
        user_ids: [],
        team_id: null,
        in_app: true,
        email: false,
      },
      {
        id: "default-sla",
        enabled: true,
        event: "sla_breached",
        assignee: true,
        user_ids: [],
        team_id: null,
        in_app: true,
        email: false,
      },
    ]),
  /** Values offered for an enquiry's source. */
  sources: z.array(z.string().min(1).max(60)).max(50).default([...DEFAULT_SOURCES]),
  /** Remind assignees this many minutes before a task is due (0 = at the due time). */
  task_reminder_lead_minutes: z.number().int().min(0).max(1440).default(0),
});

export type EnquirySettings = z.infer<typeof enquirySettingsSchema>;
export const DEFAULT_ENQUIRY_SETTINGS: EnquirySettings = enquirySettingsSchema.parse({});

export function readEnquirySettings(orgSettings: unknown): EnquirySettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).enquiries
      : undefined;
  const parsed = enquirySettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_ENQUIRY_SETTINGS;
}

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
