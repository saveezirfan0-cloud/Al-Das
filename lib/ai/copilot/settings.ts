import { z } from "zod";

/**
 * Copilot settings, stored in orgs.settings->'ai_copilot' (separate from orgs.settings->'ai' so saving the main AI switch
 * can never reset them).
 *
 *  intent_detection  send each inbound patient message to the AI provider to be labelled (booking, price, complaint, report
 *                    request, emergency). OFF by default and needs the main AI switch ON as well. It sends EVERY inbound
 *                    message, which is a bigger step than staff pressing an AI button, so it has its own switch.
 *  tag_flows         lets an AI tag START a flow. OFF by default. It can only be switched on by someone who holds
 *                    `clinical.settings.manage` (the clinical lead) typing a confirmation, is audited, and never applies to
 *                    the emergency tag (an emergency always goes to a person).  OQ-61 in docs/audit/open-questions.md.
 */
export const FLOW_TRIGGERABLE_TAGS = ["booking", "price", "complaint", "report_request"] as const;
export type FlowTriggerableTag = (typeof FLOW_TRIGGERABLE_TAGS)[number];

/** The phrase the clinical lead types to let AI tags start flows. */
export const TAG_FLOWS_CONFIRM_PHRASE = "CLINICAL LEAD APPROVES AI TAGS STARTING FLOWS";

export const copilotSettingsSchema = z.object({
  intent_detection: z.boolean().default(false),
  tag_flows: z
    .object({
      enabled: z.boolean().default(false),
      tags: z.array(z.enum(FLOW_TRIGGERABLE_TAGS)).max(FLOW_TRIGGERABLE_TAGS.length).default([]),
      signed_by: z.string().uuid().nullable().default(null),
      signed_at: z.string().nullable().default(null),
    })
    .default({ enabled: false, tags: [], signed_by: null, signed_at: null }),
});
export type CopilotSettings = z.infer<typeof copilotSettingsSchema>;
export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = copilotSettingsSchema.parse({});

export function readCopilotSettings(orgSettings: unknown): CopilotSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).ai_copilot
      : undefined;
  const parsed = copilotSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_COPILOT_SETTINGS;
}

export function writeCopilotSettings(
  orgSettings: unknown,
  next: CopilotSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.ai_copilot = copilotSettingsSchema.parse(next);
  return base;
}

/**
 * May this AI tag start flows right now? Every condition must hold: the main AI switch, intent detection, a signed
 * approval that is still switched on, the tag is on the approved list, and it is not the emergency tag.
 */
export function tagMayStartFlows(
  ai: { enabled: boolean },
  copilot: CopilotSettings,
  tag: string,
): boolean {
  return (
    ai.enabled &&
    copilot.intent_detection &&
    copilot.tag_flows.enabled &&
    !!copilot.tag_flows.signed_by &&
    !!copilot.tag_flows.signed_at &&
    (FLOW_TRIGGERABLE_TAGS as readonly string[]).includes(tag) &&
    (copilot.tag_flows.tags as readonly string[]).includes(tag)
  );
}
