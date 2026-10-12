import "server-only";

import { z } from "zod";

import { createAnthropicLlm, AiProviderError, type Llm } from "@/lib/ai/llm";
import { readCopilotSettings } from "@/lib/ai/copilot/settings";
import { detectEmergency } from "@/lib/ai/intent/emergency";
import { classifyIntent, worthClassifying } from "@/lib/ai/intent/intent";
import { applyModelIntents, handleEmergency } from "@/lib/ai/intent/server";
import { readAiSettings } from "@/lib/ai/settings";
import { AiNotConfiguredError } from "@/lib/ai/types";
import { checkOrgDailyCap, recordUsage } from "@/lib/ai/usage";
import type { AdminClient } from "@/lib/supabase/admin";

export const intentJobSchema = z.object({
  type: z.literal("intent"),
  message_id: z.string().uuid(),
});

const LABELLED_KINDS = new Set(["text", "button", "interactive"]);

/**
 * One inbound message through the two checks. Idempotent: every write is keyed on (message, source), so a redelivered job does
 * nothing twice. A transient provider error is thrown so the queue retries it; anything else is a quiet no-op. Returns a short
 * reason string for the job log (never message content).
 */
export async function processIntentJob(
  admin: AdminClient,
  messageId: string,
  deps: { llmFactory?: () => Llm; now?: () => Date } = {},
): Promise<string> {
  const { data: msg } = await admin
    .from("messages")
    .select("id, org_id, conversation_id, direction, kind, body")
    .eq("id", messageId)
    .maybeSingle();
  if (!msg) return "skipped:message_gone";
  if (msg.direction !== "in" || !LABELLED_KINDS.has(msg.kind)) return "skipped:not_text";

  const [{ data: org }, { data: conv }] = await Promise.all([
    admin.from("orgs").select("settings").eq("id", msg.org_id).maybeSingle(),
    admin
      .from("conversations")
      .select("contact_id")
      .eq("id", msg.conversation_id)
      .eq("org_id", msg.org_id)
      .maybeSingle(),
  ]);

  // 1. Wording check: deterministic, no model, works with the AI switch off.
  const wording = detectEmergency(msg.body);
  if (wording.matched) {
    await handleEmergency(
      admin,
      {
        orgId: msg.org_id,
        orgSettings: org?.settings,
        conversationId: msg.conversation_id,
        messageId: msg.id,
        source: "keyword",
        signals: wording.ids,
      },
      deps.now?.(),
    );
  }

  // 2. AI label: only with the master switch AND the intent switch on.
  const ai = readAiSettings(org?.settings);
  const copilot = readCopilotSettings(org?.settings);
  if (!ai.enabled || !copilot.intent_detection)
    return wording.matched ? "wording_only" : "skipped:ai_off";
  if (!worthClassifying(msg.body)) return wording.matched ? "wording_only" : "skipped:too_short";

  const { data: done } = await admin
    .from("ai_message_intents")
    .select("id")
    .eq("message_id", msg.id)
    .eq("source", "model")
    .maybeSingle();
  if (done) return "skipped:already_labelled";
  if (!(await checkOrgDailyCap(admin, msg.org_id, ai.daily_cap)))
    return wording.matched ? "wording_only" : "skipped:daily_cap";

  let llm: Llm;
  try {
    llm = (deps.llmFactory ?? createAnthropicLlm)();
  } catch (err) {
    if (err instanceof AiNotConfiguredError)
      return wording.matched ? "wording_only" : "skipped:no_provider";
    throw err;
  }

  const usage = {
    orgId: msg.org_id,
    userId: null,
    conversationId: msg.conversation_id,
    feature: "intent" as const,
  };
  let result;
  try {
    result = await classifyIntent({ llm }, msg.body ?? "");
  } catch (err) {
    await recordUsage(admin, { ...usage, model: llm.model, status: "error" });
    if (err instanceof AiProviderError && err.retryable) throw err; // the queue tries again
    return "failed:provider";
  }
  await recordUsage(admin, {
    ...usage,
    model: result.call.model,
    status: result.call.status,
    result: {
      inputTokens: result.call.inputTokens,
      outputTokens: result.call.outputTokens,
      latencyMs: result.call.latencyMs,
    },
  });
  const applied = await applyModelIntents(admin, {
    orgId: msg.org_id,
    orgSettings: org?.settings,
    conversationId: msg.conversation_id,
    contactId: conv?.contact_id ?? null,
    messageId: msg.id,
    intents: result.intents,
    topic: result.topic,
  });
  return applied.stored ? `labelled:${result.intents.length}` : "skipped:already_labelled";
}
