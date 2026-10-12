import "server-only";

import { PermanentJobError } from "@/lib/jobs/types";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { readInboxSettings } from "@/lib/inbox/settings";
import {
  ESCALATION_KIND,
  escalationDedupeKey,
  escalationPayload,
  planEscalation,
  readEscalationSettings,
  type EscalationLevel,
} from "@/lib/notify/escalation";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Schedules rung 1 of the ladder for a conversation that has no owner. Called when a patient writes into
 * such a conversation. One pending job per conversation and rung (dedupe key), and escalation_level stops it
 * from restarting once a rung has fired. Never throws.
 */
export async function scheduleFirstEscalation(
  orgId: string,
  orgSettings: unknown,
  conversation: { id: string; assignee_user_id: string | null; escalation_level: number },
): Promise<boolean> {
  try {
    const settings = readEscalationSettings(orgSettings);
    if (!settings.enabled || conversation.assignee_user_id || conversation.escalation_level > 0)
      return false;
    const res = await scheduleJob({
      kind: ESCALATION_KIND,
      orgId,
      runAt: new Date(Date.now() + settings.lead_after_minutes * 60_000),
      dedupeKey: escalationDedupeKey(conversation.id, 1),
      payload: { conversation_id: conversation.id, level: 1 },
    });
    return !res.deduped;
  } catch (err) {
    console.error("[escalation] could not schedule", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

/** The scheduled `inbox.escalate` job: re-checks the conversation, claims the rung, tells people, schedules the next rung. */
export async function handleEscalation(
  admin: AdminClient,
  orgId: string,
  rawPayload: unknown,
): Promise<string> {
  const parsed = escalationPayload.safeParse(rawPayload);
  if (!parsed.success) throw new PermanentJobError("invalid inbox.escalate payload");
  const { conversation_id: conversationId, level } = parsed.data;

  const [{ data: conv }, { data: org }] = await Promise.all([
    admin
      .from("conversations")
      .select("id, status, assignee_user_id, assignee_team_id, escalation_level")
      .eq("org_id", orgId)
      .eq("id", conversationId)
      .maybeSingle(),
    admin.from("orgs").select("settings").eq("id", orgId).maybeSingle(),
  ]);
  if (!conv) return "skipped:missing";
  const settings = readEscalationSettings(org?.settings);

  // The routed team's lead; conversations routed to nobody fall back to the default team's lead.
  const teamId = conv.assignee_team_id ?? readInboxSettings(org?.settings).default_team_id;
  const { data: team } = teamId
    ? await admin
        .from("teams")
        .select("lead_user_id")
        .eq("org_id", orgId)
        .eq("id", teamId)
        .maybeSingle()
    : { data: null };
  const adminIds =
    level === 2 && settings.on_call_user_ids.length === 0
      ? await memberIdsWithPermission(admin, orgId, "settings.manage")
      : [];

  const plan = planEscalation({
    level,
    conversation: conv,
    settings,
    teamLeadId: team?.lead_user_id ?? null,
    adminIds,
  });
  if (plan.action === "skip") return `skipped:${plan.reason}`;

  // Claim the rung. Only one worker wins the transition, and only while the conversation is still unowned.
  const { data: claimed } = await admin
    .from("conversations")
    .update({ escalation_level: level })
    .eq("org_id", orgId)
    .eq("id", conv.id)
    .lt("escalation_level", level)
    .is("assignee_user_id", null)
    .neq("status", "closed")
    .select("id");
  if (!claimed?.length) return "skipped:already_escalated";

  const minutes = level === 1 ? settings.lead_after_minutes : settings.on_call_after_minutes;
  if (plan.recipients.length) {
    await notify(admin, {
      orgId,
      userIds: plan.recipients,
      event: "escalation",
      type: "escalation",
      // Generic on purpose: no patient name, number or message text.
      title: level === 1 ? "A conversation has no owner" : "A conversation is still unowned",
      body: `Nobody has picked it up for ${minutes} minutes. Please take it or assign it.`,
      payload: { conversation_id: conv.id, level },
      ids: { conversation_id: conv.id },
    });
  }
  if (plan.next) {
    await scheduleJob({
      kind: ESCALATION_KIND,
      orgId,
      runAt: new Date(Date.now() + plan.next.delayMinutes * 60_000),
      dedupeKey: escalationDedupeKey(conv.id, plan.next.level as EscalationLevel),
      payload: { conversation_id: conv.id, level: plan.next.level },
    });
  }
  return `escalated:${level}:${plan.recipients.length}`;
}
