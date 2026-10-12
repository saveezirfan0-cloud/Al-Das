import { z } from "zod";

/**
 * Escalation ladder for conversations nobody owns.
 *
 *   rung 1  after `lead_after_minutes` with no owner  → the routed team's lead
 *   rung 2  after `on_call_after_minutes`             → the on-call list (org admins if the list is empty)
 *
 * Each rung is one `scheduled_jobs` row (kind `inbox.escalate`), so nothing waits in memory and a retried
 * job cannot notify twice: conversations.escalation_level is claimed atomically before anyone is told.
 * Everything here is pure; the job handler in escalation-job.ts does the database work.
 */

export const escalationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  lead_after_minutes: z.number().int().min(1).max(1440).default(10),
  on_call_after_minutes: z.number().int().min(1).max(2880).default(20),
  /** Members told at rung 2. A plain list: there is no rotation calendar yet (see docs/13). */
  on_call_user_ids: z.array(z.string().uuid()).max(20).default([]),
});
export type EscalationSettings = z.infer<typeof escalationSettingsSchema>;

export const DEFAULT_ESCALATION: EscalationSettings = escalationSettingsSchema.parse({});

/** The ladder only makes sense if rung 2 comes after rung 1. */
export function validateEscalation(s: EscalationSettings): string | null {
  if (s.on_call_after_minutes < s.lead_after_minutes)
    return "The on-call step must come after the team lead step.";
  return null;
}

export function readEscalationSettings(orgSettings: unknown): EscalationSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).escalation
      : undefined;
  const parsed = escalationSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success || validateEscalation(parsed.data)) return DEFAULT_ESCALATION;
  return parsed.data;
}

export function writeEscalationSettings(
  orgSettings: unknown,
  next: EscalationSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.escalation = next;
  return base;
}

export type EscalationLevel = 1 | 2;

export type EscalationPlan =
  | { action: "skip"; reason: "disabled" | "closed" | "assigned" | "already_escalated" }
  | {
      action: "notify";
      level: EscalationLevel;
      recipients: string[];
      /** The next rung to schedule, in minutes from now; null when the ladder ends here. */
      next: { level: 2; delayMinutes: number } | null;
    };

export function planEscalation(input: {
  level: EscalationLevel;
  conversation: { status: string; assignee_user_id: string | null; escalation_level: number };
  settings: EscalationSettings;
  teamLeadId: string | null;
  /** Fallback for rung 2 when no on-call list is set. */
  adminIds: readonly string[];
}): EscalationPlan {
  const { level, conversation, settings } = input;
  if (!settings.enabled) return { action: "skip", reason: "disabled" };
  if (conversation.status === "closed") return { action: "skip", reason: "closed" };
  if (conversation.assignee_user_id) return { action: "skip", reason: "assigned" };
  if (conversation.escalation_level >= level)
    return { action: "skip", reason: "already_escalated" };

  if (level === 1) {
    const delay = Math.max(1, settings.on_call_after_minutes - settings.lead_after_minutes);
    return {
      action: "notify",
      level: 1,
      recipients: input.teamLeadId ? [input.teamLeadId] : [],
      next: { level: 2, delayMinutes: delay },
    };
  }
  const onCall = settings.on_call_user_ids.length ? settings.on_call_user_ids : input.adminIds;
  return { action: "notify", level: 2, recipients: [...new Set(onCall)], next: null };
}

export const ESCALATION_KIND = "inbox.escalate";

export const escalationPayload = z.object({
  conversation_id: z.string().uuid(),
  level: z.union([z.literal(1), z.literal(2)]),
});

/** One pending job per conversation and rung. */
export function escalationDedupeKey(conversationId: string, level: EscalationLevel): string {
  return `${ESCALATION_KIND}:${conversationId}:${level}`;
}
