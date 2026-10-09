import { z } from "zod";

/**
 * Workspace inbox settings, stored in orgs.settings->'inbox'. Categories,
 * quick replies and labels are tables; everything scalar lives here.
 */
export const inboxSettingsSchema = z.object({
  require_category_on_close: z.boolean().default(false),
  require_summary_on_close: z.boolean().default(false),
  /** Remove conversation labels this many hours after they were added (null = never). */
  auto_remove_labels_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .default(null),
  /** Close open conversations with no activity for this many hours (null = never). */
  auto_close_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .default(null),
  /** Email the assignee when an assigned conversation stays unread this long (null = off). */
  unread_alert_minutes: z.number().int().min(15).max(180).nullable().default(null),
  /** Prefix outbound chat messages with the agent's first name. */
  show_agent_name: z.boolean().default(false),
  /** New conversations are routed to this team (null = unassigned). */
  default_team_id: z.string().uuid().nullable().default(null),
  /** Round-robin new conversations to an online member of the routed team. */
  auto_assign: z.enum(["none", "round_robin"]).default("round_robin"),
  /** Move the conversation to Waiting when an agent replies. */
  waiting_on_reply: z.boolean().default(false),
});

export type InboxSettings = z.infer<typeof inboxSettingsSchema>;

export const DEFAULT_INBOX_SETTINGS: InboxSettings = inboxSettingsSchema.parse({});

/** Reads org.settings (jsonb) → InboxSettings, tolerating missing or invalid values. */
export function readInboxSettings(orgSettings: unknown): InboxSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).inbox
      : undefined;
  const parsed = inboxSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_INBOX_SETTINGS;
}

/** Returns a new org.settings object with the inbox section replaced. */
export function writeInboxSettings(
  orgSettings: unknown,
  next: InboxSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.inbox = next;
  return base;
}
