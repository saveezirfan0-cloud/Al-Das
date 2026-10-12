"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { describeProviderFailure, openCopilot, recordCalls } from "@/lib/ai/copilot/server";
import { EmptyInputError } from "@/lib/ai/features";
import { generateFlow } from "@/lib/ai/flow-copilot/generate";
import { AI_FLOW_LIMITS } from "@/lib/ai/flow-copilot/policy";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { hasErrors, validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import { simulateFlow, SIM_LIMITS, type SimResult } from "@/lib/flow-engine/simulate";
import { graphSchema, TRIGGER_TYPES } from "@/lib/flow-engine/types";
import { checkRateLimit, RATE_RULES } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import type { ActionResult } from "./actions";

/**
 * Flow Copilot. Everything here produces DRAFTS:
 *  - draftFlowWithAi creates a NEW flow with status 'draft', version 0 and ai_review_required = true. A database trigger refuses
 *    to let such a flow become active, so nothing the model wrote can run until a person has marked it reviewed
 *    (markAiFlowReviewed) AND published it through the normal publish step.
 *  - dryRunFlow replays sample messages through any graph with every send stubbed. It writes nothing and calls nothing.
 * Prompts and replies are never stored or logged; ai_usage records tokens and outcome only.
 */

const j = (v: unknown) => v as unknown as NonNullable<Json>;

const draftSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Describe what the bot should do.")
    .max(AI_FLOW_LIMITS.maxPromptChars),
});

export type AiDraftResult = {
  id: string;
  name: string;
  triggerType: string;
  steps: number;
  repaired: boolean;
  notes: string[];
  /** Steps that still need a person to choose a template, a team or who to notify. */
  needs: { templates: number; teams: number; people: number };
  issues: GraphIssue[];
};

export async function draftFlowWithAi(
  input: z.input<typeof draftSchema>,
): Promise<ActionResult<AiDraftResult>> {
  const member = await requirePerm("flows.manage");
  if (!can(member, "flows.ai"))
    return { ok: false, error: "You don't have permission to use the Flow Copilot." };
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const opened = await openCopilot(member);
  if (!opened.ok) return { ok: false, error: opened.error };

  const { data: roles } = await opened.admin
    .from("roles")
    .select("name")
    .eq("org_id", member.orgId);

  let result;
  try {
    result = await generateFlow(
      { llm: opened.llm, clinicName: opened.clinicName },
      { request: parsed.data.prompt, lookups: { roleNames: (roles ?? []).map((r) => r.name) } },
    );
  } catch (err) {
    if (err instanceof EmptyInputError) return { ok: false, error: err.message };
    await recordCalls(opened, member, "flow_copilot", [
      { inputTokens: 0, outputTokens: 0, latencyMs: 0, model: opened.llm.model, status: "error" },
    ]);
    return { ok: false, error: describeProviderFailure(err, "flow_copilot") };
  }
  await recordCalls(opened, member, "flow_copilot", result.calls);

  if (!result.ok) {
    return {
      ok: false,
      error: result.refused
        ? "The assistant couldn't help with that request. Try describing a clinic message flow, or build the flow by hand."
        : `The assistant's draft was rejected by the checks, so nothing was created. ${result.errors.slice(0, 4).join(" ")}`,
    };
  }

  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("flows")
    .insert({
      org_id: member.orgId,
      name: result.flow.name,
      description: result.flow.description || null,
      status: "draft",
      trigger_type: result.flow.triggerType,
      trigger_config: j(result.flow.triggerConfig),
      graph: j(result.flow.graph),
      ai_review_required: true,
      ai_drafted_at: new Date().toISOString(),
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "The draft was valid but could not be saved." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.ai_drafted",
    entity: "flow",
    entityId: data.id,
    // counts and the trigger only: never the request text or the generated messages
    diff: {
      nodes: result.flow.graph.nodes.length,
      trigger: result.flow.triggerType,
      repaired: result.repaired,
    },
  });
  revalidatePath("/flows");
  return {
    ok: true,
    message: "Draft created. It is not published and cannot be until you have reviewed it.",
    data: {
      id: data.id,
      name: result.flow.name,
      triggerType: result.flow.triggerType,
      steps: result.flow.graph.nodes.length,
      repaired: result.repaired,
      notes: result.notes,
      needs: {
        templates: result.needs.templates.length,
        teams: result.needs.teams.length,
        people: result.needs.people.length,
      },
      issues: result.issues,
    },
  };
}

/** A person confirms they have read the AI draft. Only then can the normal Publish step succeed. */
export async function markAiFlowReviewed(id: string): Promise<ActionResult> {
  const member = await requirePerm("flows.manage");
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Flow not found" };
  const admin = createAdminClient(member.userId);
  const { data: flow } = await admin
    .from("flows")
    .select("id, graph, ai_review_required")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) return { ok: false, error: "Flow not found" };
  if (!flow.ai_review_required)
    return { ok: true, message: "This flow is already marked as reviewed.", data: undefined };
  const check = validateGraph(flow.graph);
  if (!check.graph || hasErrors(check.issues.filter((i) => i.kind !== "setup")))
    return { ok: false, error: "Fix the errors in the flow before marking it reviewed." };
  const { error } = await admin
    .from("flows")
    .update({
      ai_review_required: false,
      ai_reviewed_by: member.userId,
      ai_reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the review." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.ai_reviewed",
    entity: "flow",
    entityId: id,
  });
  revalidatePath(`/flows/${id}`);
  revalidatePath("/flows");
  return { ok: true, message: "Marked as reviewed. You can now publish it.", data: undefined };
}

const dryRunSchema = z.object({
  graph: graphSchema,
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  inbound: z.array(z.string().max(SIM_LIMITS.maxMessageChars)).max(SIM_LIMITS.maxInbound),
  language: z.enum(["en", "ar"]).default("en"),
});

/**
 * Replays sample patient messages through the graph on screen (saved or not). Reads the organisation's template list so a
 * chosen template can run; writes nothing, sends nothing, calls nothing outside the database read.
 */
export async function dryRunFlow(
  input: z.input<typeof dryRunSchema>,
): Promise<ActionResult<SimResult>> {
  const member = await requirePerm("flows.manage");
  const parsed = dryRunSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const limit = await checkRateLimit(
    admin,
    "flow-dry-run",
    member.userId,
    RATE_RULES.flowDryRunPerUser,
  );
  if (!limit.allowed)
    return {
      ok: false,
      error: "You are running the dry run very quickly. Wait a moment and try again.",
    };

  const { data: templates } = await admin
    .from("wa_templates")
    .select("id, name, category, status")
    .eq("org_id", member.orgId)
    .is("archived_at", null)
    .limit(500);
  const result = await simulateFlow({
    graph: parsed.data.graph,
    triggerType: parsed.data.trigger_type,
    triggerConfig: parsed.data.trigger_config,
    inbound: parsed.data.inbound,
    templates: templates ?? [],
    contact: {
      firstName: parsed.data.language === "ar" ? "سارة" : "Sample",
      language: parsed.data.language,
    },
    timezone: member.org.timezone || "Asia/Dubai",
  });
  return { ok: true, data: result };
}
