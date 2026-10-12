import { maskContactDetails } from "@/lib/ai/context";
import { EmptyInputError } from "@/lib/ai/features";
import type { Llm } from "@/lib/ai/llm";
import type { CopilotCall } from "@/lib/ai/flow-copilot/generate";
import {
  problemsOf,
  validateCopyOutput,
  type CopySuggestion,
} from "@/lib/ai/campaign-copilot/copy";
import {
  copyRepairPrompt,
  copySystemPrompt,
  copyUserPrompt,
} from "@/lib/ai/campaign-copilot/prompt";

export const MAX_BRIEF_CHARS = 800;

export type GenerateCopyResult =
  | {
      ok: true;
      suggestions: CopySuggestion[];
      repaired: boolean;
      dropped: number;
      calls: CopilotCall[];
    }
  | { ok: false; errors: string[]; refused: boolean; calls: CopilotCall[] };

/**
 * One call, lint every suggestion, and if any has lint ERRORS repair once by quoting them. After the repair the person sees
 * whatever came back with its lint results (a suggestion that still has errors cannot be saved as a draft template).
 */
export async function generateCopy(
  deps: { llm: Llm; clinicName?: string; now?: () => number },
  input: { brief: string; languages: readonly ("en" | "ar")[] },
): Promise<GenerateCopyResult> {
  const brief = maskContactDetails(input.brief.trim()).slice(0, MAX_BRIEF_CHARS);
  if (!brief) throw new EmptyInputError("Describe the campaign first.");
  const languages = input.languages.length ? input.languages : (["en", "ar"] as const);
  const now = deps.now ?? Date.now;
  const system = copySystemPrompt({ clinicName: deps.clinicName });
  const calls: CopilotCall[] = [];

  async function ask(user: string) {
    const started = now();
    const res = await deps.llm.complete({ system, user, maxTokens: 4000, effort: "low" });
    const refused = res.refused || !res.text;
    calls.push({
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: Math.max(0, now() - started),
      model: res.servedBy || deps.llm.model,
      status: refused ? "refused" : "ok",
    });
    return { text: res.text, refused };
  }

  const first = await ask(copyUserPrompt(brief, languages));
  if (first.refused)
    return {
      ok: false,
      errors: ["The assistant could not help with that request."],
      refused: true,
      calls,
    };
  const v1 = validateCopyOutput(first.text);
  const problems = problemsOf(v1);
  if (v1.ok && problems.length === 0)
    return { ok: true, suggestions: v1.suggestions, repaired: false, dropped: v1.dropped, calls };

  calls[0] = { ...calls[0]!, status: "needs_review" };
  const second = await ask(
    copyRepairPrompt(brief, languages, first.text.slice(0, 12_000), problems),
  );
  if (second.refused) {
    return v1.ok
      ? { ok: true, suggestions: v1.suggestions, repaired: false, dropped: v1.dropped, calls }
      : { ok: false, errors: v1.errors, refused: false, calls };
  }
  const v2 = validateCopyOutput(second.text);
  if (v2.ok)
    return { ok: true, suggestions: v2.suggestions, repaired: true, dropped: v2.dropped, calls };
  // The repair failed outright: keep the first attempt's suggestions (with their lint results) if there were any.
  return v1.ok
    ? { ok: true, suggestions: v1.suggestions, repaired: false, dropped: v1.dropped, calls }
    : { ok: false, errors: v2.errors, refused: false, calls };
}
