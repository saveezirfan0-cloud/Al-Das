/**
 * Campaign Copilot, template-copy half. The model proposes wording; this module turns each proposal into the builder's own
 * TemplateDraft and lints it. Nothing is submitted to Meta from here: a person saves a draft and submits it in the builder.
 */
import { z } from "zod";

import { extractJson } from "@/lib/ai/copilot/json";
import {
  AI_VARIABLE_SOURCES,
  lintTemplatePolicy,
  type LintResult,
} from "@/lib/ai/campaign-copilot/policy-lint";
import {
  alignExamples,
  draftSchema,
  emptyDraft,
  type TemplateDraft,
} from "@/lib/templates/builder";

export const COPY_LIMITS = { maxSuggestions: 4, maxButtons: 3 } as const;

const rawSuggestion = z.object({
  language: z.enum(["en", "ar"]),
  category: z.enum(["MARKETING", "UTILITY"]),
  name: z.string().max(120).optional(),
  header: z.string().max(200).optional(),
  body: z.string().min(1).max(2000),
  examples: z.array(z.string().max(60)).max(5).optional(),
  variables: z.array(z.string().max(60)).max(5).optional(),
  footer: z.string().max(200).optional(),
  buttons: z
    .array(z.object({ text: z.string().max(60) }))
    .max(5)
    .optional(),
});
const rawAnswer = z.object({ suggestions: z.array(z.unknown()).max(12) });

export type CopySuggestion = { draft: TemplateDraft; lint: LintResult };
export type CopyValidation =
  { ok: true; suggestions: CopySuggestion[]; dropped: number } | { ok: false; errors: string[] };

export function slugName(raw: string | undefined, language: string, index: number): string {
  const base = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const stem = base || `campaign_${index + 1}`;
  return stem.endsWith(`_${language}`) ? stem : `${stem}_${language}`;
}

export function suggestionToDraft(
  s: z.infer<typeof rawSuggestion>,
  index: number,
): TemplateDraft | null {
  const buttons = (s.buttons ?? [])
    .map((b) => ({ type: "QUICK_REPLY" as const, text: b.text.trim().slice(0, 25) }))
    .filter((b) => b.text)
    .slice(0, COPY_LIMITS.maxButtons);
  const variableMap: Record<string, string> = {};
  (s.variables ?? []).forEach((v, i) => {
    variableMap[`body.${i + 1}`] = v;
  });
  const body = s.body.trim();
  const draft = emptyDraft({
    name: slugName(s.name, s.language, index),
    language: s.language,
    category: s.category,
    type: buttons.length ? "media_interactive" : "standard",
    header: s.header?.trim() ? { kind: "text", text: s.header.trim() } : { kind: "none" },
    body,
    bodyExamples: alignExamples(body, s.examples ?? [], s.language === "ar" ? "سارة" : "Sara"),
    footer: (s.footer ?? "").trim(),
    buttons,
    variableMap,
  });
  const checked = draftSchema.safeParse(draft);
  return checked.success ? checked.data : null;
}

export function validateCopyOutput(rawText: string): CopyValidation {
  const json = extractJson(rawText);
  if (!json.ok) return { ok: false, errors: [json.reason] };
  const answer = rawAnswer.safeParse(json.value);
  if (!answer.success) return { ok: false, errors: ['The reply must be {"suggestions":[...]}.'] };
  const out: CopySuggestion[] = [];
  let dropped = 0;
  answer.data.suggestions.slice(0, COPY_LIMITS.maxSuggestions).forEach((candidate, i) => {
    const parsed = rawSuggestion.safeParse(candidate);
    const draft = parsed.success ? suggestionToDraft(parsed.data, i) : null;
    if (!draft) {
      dropped += 1;
      return;
    }
    out.push({ draft, lint: lintTemplatePolicy(draft, { allowedSources: AI_VARIABLE_SOURCES }) });
  });
  if (out.length === 0)
    return { ok: false, errors: ["None of the suggestions could be read as a template."] };
  return { ok: true, suggestions: out, dropped };
}

/** Suggestions that have lint errors, as short messages the repair prompt can quote. */
export function problemsOf(s: CopyValidation): string[] {
  if (!s.ok) return s.errors;
  return s.suggestions.flatMap((x, i) =>
    x.lint.issues
      .filter((l) => l.severity === "error")
      .map((l) => `Suggestion ${i + 1} (${x.draft.language}): ${l.message}`),
  );
}
