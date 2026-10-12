"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requireMember, type CurrentMember } from "@/lib/auth/session";
import { embedderFromEnv } from "@/lib/ai/embeddings";
import { ask, EmptyInputError, rewrite, suggestReply, summarize } from "@/lib/ai/features";
import { maskContactDetails, buildTranscript } from "@/lib/ai/context";
import { retrieveKnowledge } from "@/lib/ai/kb";
import { AiProviderError, createAnthropicLlm, type Llm } from "@/lib/ai/llm";
import { readAiSettings } from "@/lib/ai/settings";
import {
  AiNotConfiguredError,
  LANGUAGES,
  TONES,
  type AiFeature,
  type AiResult,
  type Passage,
  type RewriteMode,
  type TranscriptMessage,
} from "@/lib/ai/types";
import { checkRateLimit, recordUsage } from "@/lib/ai/usage";
import { listMessages } from "@/lib/inbox/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { ActionResult } from "./actions";

/**
 * Inbox AI assist. Every action: needs `ai.use`, the org's AI switch on, a conversation the caller
 * can see (RLS), and stays under the per-user rate limit. Results are DRAFTS returned to the
 * browser; nothing is sent from here. Prompts and completions are never logged or stored: only
 * tokens, latency and outcome go to ai_usage.
 */

const uuid = z.string().uuid();

export type AiPayload = {
  text: string;
  needsReview: boolean;
  flags: string[];
  /** Id of the ai_usage row: pass it back with thumbs feedback. */
  usageId: string | null;
  /** KB chunks that grounded a suggested reply (for feedback). */
  chunkIds: string[];
};

type Prepared = {
  member: CurrentMember;
  conversationId: string;
  llm: Llm;
  clinicName: string;
  transcript: string;
  messages: TranscriptMessage[];
  kbGroupIds: string[];
};

async function prepare(
  conversationId: string,
  opts: { includeNotes: boolean },
): Promise<{ error: string } | { prepared: Prepared }> {
  const member = await requireMember();
  if (!can(member, "ai.use")) return { error: "You don't have permission to use AI assist." };

  const settings = readAiSettings(member.org.settings);
  if (!settings.enabled) {
    return {
      error: "AI assist is turned off for this workspace. An administrator can enable it in Settings → AI & knowledge base.",
    };
  }

  // The user's own client, so RLS decides whether they can see this conversation at all.
  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!conversation) return { error: "Conversation not found." };

  const admin = createAdminClient();
  const limit = await checkRateLimit(admin, member.orgId, member.userId, settings.rate_limit_per_minute);
  if (!limit.allowed) return { error: "You're using AI assist very quickly. Wait a few seconds and try again." };

  let llm: Llm;
  try {
    llm = createAnthropicLlm();
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return { error: err.message };
    throw err;
  }

  const rows = await listMessages(supabase, conversation.id, 100);
  const messages: TranscriptMessage[] = rows.map((m) => ({
    direction: m.direction,
    kind: m.kind,
    body: m.body,
    at: m.at,
    byStaff: m.direction === "out" ? m.sent_by_user_id !== null : undefined,
  }));

  return {
    prepared: {
      member,
      conversationId: conversation.id,
      llm,
      clinicName: member.org.name,
      messages,
      transcript: buildTranscript(messages, { includeNotes: opts.includeNotes }),
      kbGroupIds: settings.kb_group_ids,
    },
  };
}

async function execute(
  feature: AiFeature,
  p: Prepared,
  fn: () => Promise<AiResult>,
): Promise<ActionResult<AiPayload>> {
  const admin = createAdminClient();
  const usage = { orgId: p.member.orgId, userId: p.member.userId, conversationId: p.conversationId, feature, model: p.llm.model };

  let result: AiResult;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof EmptyInputError) return { ok: false, error: err.message };
    if (err instanceof AiProviderError) {
      await recordUsage(admin, { ...usage, status: "error" });
      return { ok: false, error: err.message };
    }
    await recordUsage(admin, { ...usage, status: "error" });
    // name only: the message may contain prompt text
    console.error("[ai] unexpected failure", { feature, error: err instanceof Error ? err.name : "unknown" });
    return { ok: false, error: "AI assist hit a problem. Please try again." };
  }

  const usageId = await recordUsage(admin, { ...usage, model: result.model, status: result.status, result });
  if (result.status === "refused") {
    return { ok: false, error: "The assistant couldn't help with that request. Write the reply yourself or hand it to a colleague." };
  }
  return {
    ok: true,
    data: {
      text: result.text,
      needsReview: result.status === "needs_review",
      flags: result.flags,
      usageId,
      chunkIds: result.chunkIds,
    },
  };
}

const conversationOnly = z.object({ conversation_id: uuid });

export async function aiSummarize(input: z.input<typeof conversationOnly>): Promise<ActionResult<AiPayload>> {
  const parsed = conversationOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const prep = await prepare(parsed.data.conversation_id, { includeNotes: true });
  if ("error" in prep) return { ok: false, error: prep.error };
  const p = prep.prepared;
  return execute("summarize", p, () => summarize({ llm: p.llm, clinicName: p.clinicName }, { transcript: p.transcript }));
}

const askSchema = z.object({ conversation_id: uuid, question: z.string().trim().min(1, "Type a question first.").max(500) });

export async function aiAsk(input: z.input<typeof askSchema>): Promise<ActionResult<AiPayload>> {
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const prep = await prepare(parsed.data.conversation_id, { includeNotes: true });
  if ("error" in prep) return { ok: false, error: prep.error };
  const p = prep.prepared;
  return execute("ask", p, () =>
    ask({ llm: p.llm, clinicName: p.clinicName }, { transcript: p.transcript, question: parsed.data.question }),
  );
}

const suggestSchema = z.object({ conversation_id: uuid, instruction: z.string().trim().max(500).optional() });

export async function aiSuggestReply(input: z.input<typeof suggestSchema>): Promise<ActionResult<AiPayload>> {
  const parsed = suggestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  // Patient-facing draft: internal notes stay out of the prompt.
  const prep = await prepare(parsed.data.conversation_id, { includeNotes: false });
  if ("error" in prep) return { ok: false, error: prep.error };
  const p = prep.prepared;

  return execute("suggest_reply", p, async () => {
    // Retrieve from the KB using the patient's latest messages. Without embeddings configured the
    // draft is still produced, just ungrounded (and flagged as such).
    let passages: Passage[] = [];
    const patientText = p.messages
      .filter((m) => m.direction === "in" && m.body?.trim())
      .slice(-3)
      .map((m) => maskContactDetails(m.body!.trim()))
      .join("\n");
    if (patientText) {
      try {
        passages = await retrieveKnowledge(createAdminClient(), embedderFromEnv(), {
          orgId: p.member.orgId,
          query: patientText,
          groupIds: p.kbGroupIds,
        });
      } catch (err) {
        if (!(err instanceof AiNotConfiguredError)) {
          console.error("[ai] knowledge retrieval failed", { error: err instanceof Error ? err.name : "unknown" });
        }
      }
    }
    return suggestReply(
      { llm: p.llm, clinicName: p.clinicName },
      { transcript: p.transcript, passages, extraInstruction: parsed.data.instruction },
    );
  });
}

const rewriteSchema = z.object({
  conversation_id: uuid,
  draft: z.string().trim().min(1, "Write a message first.").max(4000),
  mode: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tone"), tone: z.enum(TONES) }),
    z.object({ kind: z.literal("language"), language: z.enum(LANGUAGES) }),
    z.object({ kind: z.literal("grammar") }),
  ]),
});

export async function aiRewrite(input: z.input<typeof rewriteSchema>): Promise<ActionResult<AiPayload>> {
  const parsed = rewriteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const prep = await prepare(parsed.data.conversation_id, { includeNotes: false });
  if ("error" in prep) return { ok: false, error: prep.error };
  const p = prep.prepared;
  const mode: RewriteMode = parsed.data.mode;
  return execute("rewrite", p, () => rewrite({ llm: p.llm, clinicName: p.clinicName }, { draft: parsed.data.draft, mode }));
}

const feedbackSchema = z.object({
  usage_id: uuid,
  positive: z.boolean(),
  note: z.string().trim().max(500).optional(),
  chunk_ids: z.array(uuid).max(20).default([]),
});

/** Thumbs up/down on a result. The draft text is not stored: only the verdict and (optionally) a short note. */
export async function aiFeedback(input: z.input<typeof feedbackSchema>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "ai.use")) return { ok: false, error: "You don't have permission to use AI assist." };
  const parsed = feedbackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const admin = createAdminClient();
  // Only feedback on one's own AI call, in this org.
  const { data: usage } = await admin
    .from("ai_usage")
    .select("id, feature, conversation_id")
    .eq("id", parsed.data.usage_id)
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId)
    .maybeSingle();
  if (!usage) return { ok: false, error: "That AI result is no longer available." };

  // Chunk ids come from the browser: keep only ones that really are this org's.
  let chunkIds: string[] = [];
  if (parsed.data.chunk_ids.length) {
    const { data: chunks } = await admin
      .from("kb_chunks")
      .select("id")
      .eq("org_id", member.orgId)
      .in("id", parsed.data.chunk_ids);
    chunkIds = (chunks ?? []).map((c) => c.id);
  }

  const { data: existing } = await admin
    .from("kb_feedback")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("ai_usage_id", usage.id)
    .eq("user_id", member.userId)
    .maybeSingle();
  const row = { positive: parsed.data.positive, note: parsed.data.note ?? null, chunk_ids: chunkIds };
  const { error } = existing
    ? await admin.from("kb_feedback").update(row).eq("id", existing.id)
    : await admin.from("kb_feedback").insert({
        ...row,
        org_id: member.orgId,
        user_id: member.userId,
        conversation_id: usage.conversation_id,
        ai_usage_id: usage.id,
        feature: usage.feature as AiFeature,
      });
  if (error) return { ok: false, error: "Could not save your feedback." };
  return { ok: true, data: undefined, message: "Thanks for the feedback." };
}

const saveSummarySchema = z.object({ conversation_id: uuid, summary: z.string().trim().min(1).max(2000) });

/** Stores an (edited) summary on the conversation. Explicit, user-initiated: AI never writes it on its own. */
export async function saveConversationSummary(input: z.input<typeof saveSummarySchema>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "inbox.send")) return { ok: false, error: "You don't have permission for that." };
  const parsed = saveSummarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", parsed.data.conversation_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!conversation) return { ok: false, error: "Conversation not found." };

  const { error } = await createAdminClient()
    .from("conversations")
    .update({ summary: parsed.data.summary })
    .eq("id", conversation.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the summary." };
  revalidatePath("/inbox");
  return { ok: true, data: undefined, message: "Summary saved." };
}
