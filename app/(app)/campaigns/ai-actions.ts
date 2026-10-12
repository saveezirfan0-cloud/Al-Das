"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  buildAudienceCatalogue,
  describeAudience,
  validateAudienceFilter,
  withMarketingEligibility,
} from "@/lib/ai/campaign-copilot/audience";
import {
  generateAudience,
  MAX_AUDIENCE_REQUEST_CHARS,
} from "@/lib/ai/campaign-copilot/generate-audience";
import { generateCopy, MAX_BRIEF_CHARS } from "@/lib/ai/campaign-copilot/generate-copy";
import { lintTemplatePolicy, type LintIssue } from "@/lib/ai/campaign-copilot/policy-lint";
import { loadAudienceContext } from "@/lib/ai/campaign-copilot/server";
import { describeProviderFailure, openCopilot, recordCalls } from "@/lib/ai/copilot/server";
import { EmptyInputError } from "@/lib/ai/features";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { countContacts, matchingContactIds } from "@/lib/contacts/query";
import { filterSchema, type Filter } from "@/lib/filters/ast";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { draftSchema, type TemplateDraft } from "@/lib/templates/builder";
import { saveTemplateDraft } from "../templates/actions";

type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

/**
 * Campaign Copilot. Drafts only: nothing here sends a message, schedules a campaign or submits a template to Meta.
 *  - previewAiAudience turns a sentence into a validated filter and shows the matching COUNT and a few contact IDS (no names,
 *    no phone numbers) so a person can judge it before using it.
 *  - suggestTemplateCopy returns English and Arabic wording with a Meta-policy lint.
 *  - saveAiAudienceSegment / saveAiTemplateDraft keep a result as a dynamic segment / a DRAFT template, after re-validating it.
 * The model sees field names, the clinic's tag / place / service ids and the sentence typed: never a patient.
 */

const SAMPLE_IDS = 10;
const j = (v: unknown) => v as unknown as NonNullable<Json>;

export type AudiencePreview = {
  filter: Filter;
  explanation: string;
  /** The filter in plain words, ids replaced by names. */
  lines: string[];
  warnings: string[];
  repaired: boolean;
  /** Everyone the filter matches. */
  total: number;
  /** Of those, the ones a MARKETING campaign could reach (opted in and not stopped). */
  marketingEligible: number;
  /** Contact ids only. */
  sampleIds: string[];
};

const audienceSchema = z.object({
  request: z.string().trim().min(1, "Describe the audience first.").max(MAX_AUDIENCE_REQUEST_CHARS),
});

export async function previewAiAudience(
  input: z.input<typeof audienceSchema>,
): Promise<ActionResult<AudiencePreview>> {
  const member = await requirePerm("campaigns.create");
  if (!can(member, "campaigns.ai"))
    return { ok: false, error: "You don't have permission to use the Campaign Copilot." };
  const parsed = audienceSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const opened = await openCopilot(member);
  if (!opened.ok) return { ok: false, error: opened.error };
  const { registry, sets } = await loadAudienceContext(opened.admin, member.orgId);
  const timezone = member.org.timezone || "Asia/Dubai";

  let result;
  try {
    result = await generateAudience(
      { llm: opened.llm, clinicName: opened.clinicName },
      {
        request: parsed.data.request,
        catalogue: buildAudienceCatalogue(registry, sets),
        registry,
        sets,
        timezone,
        today: new Date().toISOString().slice(0, 10),
      },
    );
  } catch (err) {
    if (err instanceof EmptyInputError) return { ok: false, error: err.message };
    await recordCalls(opened, member, "campaign_audience", [
      { inputTokens: 0, outputTokens: 0, latencyMs: 0, model: opened.llm.model, status: "error" },
    ]);
    return { ok: false, error: describeProviderFailure(err, "campaign_audience") };
  }
  await recordCalls(opened, member, "campaign_audience", result.calls);
  if (!result.ok) {
    return {
      ok: false,
      error: result.refused
        ? "The assistant couldn't help with that request."
        : result.declined
          ? (result.errors[0] ?? "The assistant could not build an audience from that.")
          : `The assistant's audience was rejected by the checks. ${result.errors.slice(0, 3).join(" ")}`,
    };
  }

  try {
    const admin = opened.admin;
    const [total, marketingEligible, ids] = await Promise.all([
      countContacts(admin, member.orgId, registry, result.filter, timezone),
      countContacts(
        admin,
        member.orgId,
        registry,
        withMarketingEligibility(result.filter),
        timezone,
      ),
      matchingContactIds(admin, member.orgId, registry, result.filter, null, timezone, SAMPLE_IDS),
    ]);
    await recordAccess(admin, member, {
      entity: "contact",
      action: "list",
      detail: { rows: ids.length, via: "campaign_copilot" },
    });
    return {
      ok: true,
      data: {
        filter: result.filter,
        explanation: result.explanation,
        lines: describeAudience(result.filter, registry, sets),
        warnings: result.warnings,
        repaired: result.repaired,
        total,
        marketingEligible,
        sampleIds: ids,
      },
    };
  } catch {
    return { ok: false, error: "The audience was valid but could not be counted. Try again." };
  }
}

const segmentSchema = z.object({
  name: z.string().trim().min(1, "Give the segment a name.").max(80),
  filter: filterSchema,
});

/** Keeps a previewed audience as a DYNAMIC segment (a saved filter) the New campaign form can pick. Re-validated here. */
export async function saveAiAudienceSegment(
  input: z.input<typeof segmentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("campaigns.create");
  if (!can(member, "campaigns.ai"))
    return { ok: false, error: "You don't have permission to use the Campaign Copilot." };
  const parsed = segmentSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { registry, sets } = await loadAudienceContext(admin, member.orgId);
  const timezone = member.org.timezone || "Asia/Dubai";
  // The browser sent this filter back: it is checked again, exactly as the model's answer was.
  const checked = validateAudienceFilter(parsed.data.filter, { registry, sets, timezone });
  if (!checked.ok) return { ok: false, error: checked.errors.slice(0, 2).join(" ") };

  let count = 0;
  try {
    count = await countContacts(admin, member.orgId, registry, checked.filter, timezone);
  } catch {
    return { ok: false, error: "The audience could not be counted." };
  }
  const { data, error } = await admin
    .from("segments")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      kind: "dynamic",
      filter: j(checked.filter),
      member_count: count,
      count_refreshed_at: new Date().toISOString(),
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data)
    return {
      ok: false,
      error:
        error?.code === "23505"
          ? "A segment with that name exists."
          : "Could not create the segment.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "segment.created",
    entity: "segment",
    entityId: data.id,
    diff: { name: parsed.data.name, kind: "dynamic", via: "campaign_copilot" },
  });
  revalidatePath("/campaigns/new");
  revalidatePath("/contacts");
  return {
    ok: true,
    message: "Saved as a segment. Pick it when you create a campaign.",
    data: { id: data.id },
  };
}

const copySchema = z.object({
  brief: z.string().trim().min(1, "Describe the campaign first.").max(MAX_BRIEF_CHARS),
  languages: z
    .array(z.enum(["en", "ar"]))
    .min(1)
    .max(2)
    .default(["en", "ar"]),
});

export type CopySuggestionView = {
  draft: TemplateDraft;
  ok: boolean;
  issues: LintIssue[];
  looksLike: "MARKETING" | "UTILITY";
};

export async function suggestTemplateCopy(
  input: z.input<typeof copySchema>,
): Promise<ActionResult<{ suggestions: CopySuggestionView[]; repaired: boolean }>> {
  const member = await requirePerm("campaigns.create");
  if (!can(member, "campaigns.ai"))
    return { ok: false, error: "You don't have permission to use the Campaign Copilot." };
  const parsed = copySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const opened = await openCopilot(member);
  if (!opened.ok) return { ok: false, error: opened.error };

  let result;
  try {
    result = await generateCopy(
      { llm: opened.llm, clinicName: opened.clinicName },
      { brief: parsed.data.brief, languages: parsed.data.languages },
    );
  } catch (err) {
    if (err instanceof EmptyInputError) return { ok: false, error: err.message };
    await recordCalls(opened, member, "campaign_copy", [
      { inputTokens: 0, outputTokens: 0, latencyMs: 0, model: opened.llm.model, status: "error" },
    ]);
    return { ok: false, error: describeProviderFailure(err, "campaign_copy") };
  }
  await recordCalls(opened, member, "campaign_copy", result.calls);
  if (!result.ok)
    return {
      ok: false,
      error: result.refused
        ? "The assistant couldn't help with that request."
        : `The assistant's wording could not be used. ${result.errors.slice(0, 2).join(" ")}`,
    };
  return {
    ok: true,
    data: {
      repaired: result.repaired,
      suggestions: result.suggestions.map((s) => ({
        draft: s.draft,
        ok: s.lint.ok,
        issues: s.lint.issues,
        looksLike: s.lint.looksLike,
      })),
    },
  };
}

const saveCopySchema = z.object({ channel_id: z.string().uuid(), draft: draftSchema });

/** Keeps a suggestion as a DRAFT template (nothing goes to Meta). Re-linted here: a suggestion with errors cannot be saved. */
export async function saveAiTemplateDraft(
  input: z.input<typeof saveCopySchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("templates.manage");
  if (!can(member, "campaigns.ai"))
    return { ok: false, error: "You don't have permission to use the Campaign Copilot." };
  const parsed = saveCopySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That template is not valid." };
  const lint = lintTemplatePolicy(parsed.data.draft);
  if (!lint.ok) {
    const first = lint.issues
      .filter((i) => i.severity === "error")
      .slice(0, 2)
      .map((i) => i.message);
    return { ok: false, error: `Fix this before saving: ${first.join(" ")}` };
  }
  const saved = await saveTemplateDraft({
    channel_id: parsed.data.channel_id,
    draft: parsed.data.draft,
  });
  if (!saved.ok) return saved;
  await recordAudit(createAdminClient(member.userId), {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.ai_draft_saved",
    entity: "wa_template",
    entityId: saved.data.id,
    diff: { language: parsed.data.draft.language, category: parsed.data.draft.category },
  });
  return saved;
}
