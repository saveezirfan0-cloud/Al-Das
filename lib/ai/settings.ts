import { z } from "zod";

/**
 * AI settings, stored in orgs.settings->'ai'. AI is OFF until an admin turns it on: conversation
 * text is sent to the AI provider, and data residency (OQ-49) is a go-live decision.
 */
export const aiSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Knowledge-base groups Suggested Reply may draw from (empty = every group). */
  kb_group_ids: z.array(z.string().uuid()).max(50).default([]),
  /** Calls per user per minute, across all AI features. */
  rate_limit_per_minute: z.number().int().min(1).max(60).default(10),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const DEFAULT_AI_SETTINGS: AiSettings = aiSettingsSchema.parse({});

export function readAiSettings(orgSettings: unknown): AiSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).ai
      : undefined;
  const parsed = aiSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
}

export function writeAiSettings(orgSettings: unknown, next: AiSettings): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.ai = aiSettingsSchema.parse(next);
  return base;
}
