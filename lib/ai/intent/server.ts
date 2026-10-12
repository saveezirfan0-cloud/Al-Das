import "server-only";

import { emit } from "@/lib/events/emit";
import { readAiSettings } from "@/lib/ai/settings";
import { readCopilotSettings, tagMayStartFlows } from "@/lib/ai/copilot/settings";
import { detectEmergency } from "@/lib/ai/intent/emergency";
import { type Intent, type Topic, worthClassifying } from "@/lib/ai/intent/intent";
import { planEmergencyRecipients, withinNotifyWindow } from "@/lib/ai/intent/recipients";
import { takeOverFromBot } from "@/lib/flow-engine/takeover";
import { readInboxSettings } from "@/lib/inbox/settings";
import { enqueue } from "@/lib/jobs/enqueue";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { readEscalationSettings } from "@/lib/notify/escalation";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Database side of intent detection. Two entry points:
 *
 *  screenInboundMessage   called from processInbound for every inbound message. Pure wording check for emergencies (no
 *                         model, works with AI off), escalates on the spot, and queues the AI label when it is switched on.
 *                         NEVER throws and never calls the model: inbound handling stays fast.
 *  handleEmergency / applyModelIntents   idempotent writers used by the inline path and by the queue job.
 *
 * What is stored: labels, closed topics and pattern ids. Never the message. What is notified: ids and a fixed sentence.
 */

type Log = {
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
};
const consoleLog: Log = {
  warn: (m, meta) => console.warn(m, meta),
  error: (m, meta) => console.error(m, meta),
};

export type EmergencyOutcome = "escalated" | "suppressed" | "already";

/**
 * A possible emergency was seen in this message (by wording, or by the model). Tags the conversation, stops any bot run, and
 * tells the owner, the team lead and the on-call people. Idempotent per (message, source).
 */
export async function handleEmergency(
  admin: AdminClient,
  args: {
    orgId: string;
    orgSettings: unknown;
    conversationId: string;
    messageId: string;
    source: "keyword" | "model";
    signals?: string[];
    topic?: Topic | null;
  },
  now: Date = new Date(),
): Promise<EmergencyOutcome> {
  // 1. Claim the (message, source) row. An existing row that was already escalated means there is nothing left to do.
  const { error: insertError } = await admin.from("ai_message_intents").insert({
    org_id: args.orgId,
    conversation_id: args.conversationId,
    message_id: args.messageId,
    source: args.source,
    intents: ["emergency"],
    signals: args.signals ?? [],
    topic: args.topic ?? null,
  });
  if (insertError && insertError.code !== "23505")
    throw new Error(`intent insert failed (${insertError.code})`);
  const { data: row } = await admin
    .from("ai_message_intents")
    .select("id, escalated_at")
    .eq("message_id", args.messageId)
    .eq("source", args.source)
    .maybeSingle();
  if (!row) throw new Error("intent row missing");
  if (row.escalated_at) return "already";

  // 2. Tag, and stop the bot talking to someone who may be in danger.
  await admin.rpc("ai_add_conversation_tags", {
    p_org: args.orgId,
    p_conversation: args.conversationId,
    p_tags: ["emergency"],
  });
  await takeOverFromBot(admin, args.conversationId, "Possible emergency");

  // 3. Tell people, unless this conversation already escalated a moment ago.
  const { data: recent } = await admin
    .from("ai_message_intents")
    .select("escalated_at")
    .eq("conversation_id", args.conversationId)
    .neq("id", row.id)
    .not("escalated_at", "is", null)
    .order("escalated_at", { ascending: false })
    .limit(1);
  const last = recent?.[0]?.escalated_at ? new Date(recent[0].escalated_at) : null;
  let outcome: EmergencyOutcome = "suppressed";
  if (!withinNotifyWindow(last, now)) {
    const { data: conv } = await admin
      .from("conversations")
      .select("assignee_user_id, assignee_team_id")
      .eq("id", args.conversationId)
      .eq("org_id", args.orgId)
      .maybeSingle();
    const teamId = conv?.assignee_team_id ?? readInboxSettings(args.orgSettings).default_team_id;
    const { data: team } = teamId
      ? await admin
          .from("teams")
          .select("lead_user_id")
          .eq("id", teamId)
          .eq("org_id", args.orgId)
          .maybeSingle()
      : { data: null };
    const onCall = readEscalationSettings(args.orgSettings).on_call_user_ids;
    const base = {
      ownerId: conv?.assignee_user_id ?? null,
      teamLeadId: team?.lead_user_id ?? null,
      onCallIds: onCall,
    };
    const recipients = planEmergencyRecipients({
      ...base,
      adminIds: planNeedsAdmins(base)
        ? await memberIdsWithPermission(admin, args.orgId, "settings.manage")
        : [],
    });
    if (recipients.length) {
      await notify(admin, {
        orgId: args.orgId,
        userIds: recipients,
        event: "inbox.emergency",
        type: "escalation",
        // Generic on purpose: no name, number, quotation or label of what was said.
        title: "A patient message may be urgent",
        body: "The wording of a new message suggests an emergency. Open the conversation now.",
        payload: { conversation_id: args.conversationId },
        ids: { conversation_id: args.conversationId },
      });
    }
    outcome = "escalated";
  }
  await admin
    .from("ai_message_intents")
    .update({ escalated_at: now.toISOString() })
    .eq("id", row.id);
  return outcome;
}

function planNeedsAdmins(b: {
  ownerId: string | null;
  teamLeadId: string | null;
  onCallIds: readonly string[];
}): boolean {
  return !b.ownerId && !b.teamLeadId && b.onCallIds.length === 0;
}

/**
 * Stores the model's label and acts on it. Idempotent per message. An AI tag may start a flow ONLY when the clinical lead has
 * signed that off (tagMayStartFlows); an emergency never does, it goes to a person.
 */
export async function applyModelIntents(
  admin: AdminClient,
  args: {
    orgId: string;
    orgSettings: unknown;
    conversationId: string;
    contactId: string | null;
    messageId: string;
    intents: Intent[];
    topic: Topic;
  },
): Promise<{ stored: boolean; newTags: string[]; emergency: EmergencyOutcome | null }> {
  const { error } = await admin.from("ai_message_intents").insert({
    org_id: args.orgId,
    conversation_id: args.conversationId,
    message_id: args.messageId,
    source: "model",
    intents: args.intents,
    topic: args.topic,
  });
  if (error) {
    if (error.code === "23505") return { stored: false, newTags: [], emergency: null };
    throw new Error(`intent insert failed (${error.code})`);
  }
  const nonEmergency = args.intents.filter((i) => i !== "emergency");
  let newTags: string[] = [];
  if (nonEmergency.length) {
    const { data } = await admin.rpc("ai_add_conversation_tags", {
      p_org: args.orgId,
      p_conversation: args.conversationId,
      p_tags: nonEmergency,
    });
    newTags = data ?? [];
  }
  let emergency: EmergencyOutcome | null = null;
  if (args.intents.includes("emergency")) {
    emergency = await handleEmergency(admin, { ...args, source: "model" });
  }
  // Tags -> flows: only with the clinical lead's signed approval, and only for tags that were just added.
  const ai = readAiSettings(args.orgSettings);
  const copilot = readCopilotSettings(args.orgSettings);
  const startable = newTags.filter((t) => tagMayStartFlows(ai, copilot, t));
  if (startable.length) {
    await emit(args.orgId, "conversation.ai_tagged", {
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      tags: startable,
    });
  }
  return { stored: true, newTags, emergency };
}

/**
 * Called by processInbound for each inbound message. Never throws. Emergency wording is handled here and now; the AI label
 * (if switched on) is queued, as is a retry of an emergency that failed on this attempt.
 */
export async function screenInboundMessage(
  admin: AdminClient,
  args: {
    orgId: string;
    orgSettings: unknown;
    conversationId: string;
    messageId: string;
    body: string | null;
  },
  log: Log = consoleLog,
): Promise<void> {
  try {
    const wording = detectEmergency(args.body);
    let needsJob = false;
    if (wording.matched) {
      try {
        await handleEmergency(admin, { ...args, source: "keyword", signals: wording.ids });
      } catch (err) {
        // Do not lose it: the queue retries the same idempotent step.
        log.error("[ai] emergency escalation failed; queued for retry", {
          error: err instanceof Error ? err.name : "unknown",
        });
        needsJob = true;
      }
    }
    const ai = readAiSettings(args.orgSettings);
    const copilot = readCopilotSettings(args.orgSettings);
    if (ai.enabled && copilot.intent_detection && worthClassifying(args.body)) needsJob = true;
    if (needsJob) await enqueue("ai_insights", { type: "intent", message_id: args.messageId });
  } catch (err) {
    log.error("[ai] inbound screening failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
