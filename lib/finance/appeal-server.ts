import "server-only";

import { AiProviderError, createAnthropicLlm, type Llm } from "@/lib/ai/llm";
import { readAiSettings } from "@/lib/ai/settings";
import { AiNotConfiguredError, type AiStatus } from "@/lib/ai/types";
import { checkRateLimit, recordUsage } from "@/lib/ai/usage";
import { fail, type ActionResult } from "@/lib/finance/action-support";
import { draftAppeal, type AppealFacts } from "@/lib/finance/appeal";
import { lookupDenialCode, type DenialCategory, type DenialCodeRow } from "@/lib/finance/denials";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Builds and stores an appeal draft for a denial case. The case row already holds only identifiers, a denial code and
 * amounts, so nothing about a patient can reach the model. AI is used only when the workspace switch is ON, within the same
 * per-user and daily limits as every AI feature, and its usage is logged without any text. The result is ALWAYS a draft:
 * there is no code path that sends it anywhere.
 */

export type AppealRequest = {
  orgId: string;
  orgName: string;
  orgSettings: unknown;
  userId: string;
  caseId: string;
  mode: "ai" | "template";
  language: "en" | "ar";
  today: string;
  /** Test seam: the real one is createAnthropicLlm(). */
  llmFactory?: () => Llm;
};

async function loadTaxonomy(admin: AdminClient, orgId: string): Promise<DenialCodeRow[]> {
  const { data } = await admin
    .from("fin_ref_denial_codes")
    .select(
      "code, is_family, description, category, default_owner_role, resubmit_days, appealable, active",
    )
    .eq("org_id", orgId);
  return (data ?? []).map((r) => ({
    code: r.code,
    isFamily: r.is_family,
    description: r.description,
    category: r.category as DenialCategory,
    defaultOwnerRole: r.default_owner_role as DenialCodeRow["defaultOwnerRole"],
    resubmitDays: r.resubmit_days,
    appealable: r.appealable,
    active: r.active,
  }));
}

export async function generateAppealDraft(
  admin: AdminClient,
  req: AppealRequest,
): Promise<
  ActionResult<{ draftId: string; kind: "ai" | "template"; flags: string[]; notice: string | null }>
> {
  const { data: c } = await admin
    .from("ins_denial_cases")
    .select(
      "id, claim_number, invoice_no, cpt_code, payer_id, claim_net, rejected_amount, reason_code, category, denied_on, deadline_on, appealable, claim_activity_id",
    )
    .eq("id", req.caseId)
    .eq("org_id", req.orgId)
    .maybeSingle();
  if (!c) return fail("That denial case was not found.");

  const taxonomy = await loadTaxonomy(admin, req.orgId);
  const code = lookupDenialCode(c.reason_code, taxonomy);
  const { data: claim } = await admin
    .from("ins_claim_activities")
    .select("prior_auth_id")
    .eq("id", c.claim_activity_id)
    .eq("org_id", req.orgId)
    .maybeSingle();
  const facts: AppealFacts = {
    clinicName: req.orgName,
    claimNumber: c.claim_number,
    invoiceNo: c.invoice_no,
    cptCode: c.cpt_code,
    payerId: c.payer_id,
    reasonCode: c.reason_code,
    reasonDescription: code?.description ?? null,
    category: c.category as DenialCategory,
    claimedAmount: c.claim_net === null ? null : Number(c.claim_net),
    deniedAmount: Number(c.rejected_amount),
    deniedOn: c.denied_on,
    deadlineOn: c.deadline_on,
    priorAuthId: claim?.prior_auth_id ?? null,
  };

  let llm: Llm | null = null;
  const usage = {
    orgId: req.orgId,
    userId: req.userId,
    conversationId: null,
    feature: "appeal_draft" as const,
  };
  if (req.mode === "ai") {
    const settings = readAiSettings(req.orgSettings);
    if (!settings.enabled)
      return fail(
        "AI is turned off for this workspace. Use the standard template, or ask an administrator to turn AI on in Settings.",
      );
    const limit = await checkRateLimit(
      admin,
      req.orgId,
      req.userId,
      settings.rate_limit_per_minute,
      settings.daily_cap,
    );
    if (!limit.allowed)
      return fail(
        limit.reason === "daily"
          ? "Your workspace has reached its daily AI limit. Use the standard template, or try tomorrow."
          : "You are using AI very quickly. Wait a few seconds and try again.",
      );
    try {
      llm = (req.llmFactory ?? createAnthropicLlm)();
    } catch (err) {
      if (err instanceof AiNotConfiguredError) return fail(err.message);
      throw err;
    }
  }

  let draft;
  try {
    draft = await draftAppeal({ llm, facts, today: req.today, language: req.language });
  } catch (err) {
    await recordUsage(admin, { ...usage, model: llm?.model ?? "unknown", status: "error" });
    if (err instanceof AiProviderError) return fail(err.message);
    // the class name only: the message may echo prompt text
    console.error("[finance] appeal draft failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return fail("The draft could not be written. Use the standard template instead.");
  }

  if (llm) {
    const status: AiStatus = draft.refused
      ? "refused"
      : draft.flags.length > 0
        ? "needs_review"
        : "ok";
    await recordUsage(admin, {
      ...usage,
      model: draft.model ?? llm.model,
      status,
      result: {
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
        latencyMs: draft.latencyMs,
      },
    });
  }

  const { data: row, error } = await admin
    .from("ins_appeal_drafts")
    .insert({
      org_id: req.orgId,
      case_id: req.caseId,
      kind: draft.kind,
      language: draft.language,
      body: draft.body,
      model: draft.model,
      flags: draft.flags,
      created_by: req.userId,
    })
    .select("id")
    .single();
  if (error || !row) {
    console.error("[finance] appeal draft not saved", {
      code: error?.code,
      detail: redactText(error?.message ?? "", 80),
    });
    return fail("The draft could not be saved.");
  }
  const notice =
    req.mode === "ai" && draft.kind === "template"
      ? "The AI declined, so the standard template was used."
      : null;
  return { ok: true, data: { draftId: row.id, kind: draft.kind, flags: draft.flags, notice } };
}
