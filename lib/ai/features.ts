import { checkDraft } from "@/lib/ai/guardrails";
import type { Llm, LlmResult } from "@/lib/ai/llm";
import { guardrailSystemPrompt } from "@/lib/ai/prompts/guardrail";
import { askPrompt, rewritePrompt, suggestReplyPrompt, summarizePrompt } from "@/lib/ai/prompts/tasks";
import type { AiResult, Passage, RewriteMode } from "@/lib/ai/types";

/**
 * The four inbox AI features. Pure orchestration over an injected `Llm`: build the prompt, call the
 * model, run the output checks, return a DRAFT. Nothing here sends a message or touches the
 * database, and nothing logs prompt or completion text.
 */

export class EmptyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyInputError";
  }
}

export const MAX_QUESTION_CHARS = 500;
export const MAX_DRAFT_CHARS = 4_000;

type Common = { llm: Llm; clinicName?: string; now?: () => number };

async function run(
  deps: Common,
  user: string,
  opts: { patientFacing: boolean; effort: "low" | "medium"; chunkIds?: string[]; extraFlags?: string[]; sourceText?: string },
): Promise<AiResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const res: LlmResult = await deps.llm.complete({
    system: guardrailSystemPrompt({ clinicName: deps.clinicName }),
    user,
    effort: opts.effort,
  });
  const latencyMs = Math.max(0, now() - started);
  const base = {
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    latencyMs,
    model: res.servedBy || deps.llm.model,
    chunkIds: opts.chunkIds ?? [],
  };

  if (res.refused || !res.text) {
    return { ...base, text: "", status: "refused", flags: ["The assistant could not help with this request."] };
  }
  if (!opts.patientFacing) {
    const flags = opts.extraFlags ?? [];
    return { ...base, text: res.text, status: flags.length ? "needs_review" : "ok", flags };
  }
  const checked = checkDraft(res.text, { sourceText: opts.sourceText });
  const flags = [...checked.flags, ...(opts.extraFlags ?? [])];
  return { ...base, text: checked.text, status: flags.length ? "needs_review" : "ok", flags };
}

export async function summarize(deps: Common, input: { transcript: string }): Promise<AiResult> {
  if (!input.transcript.trim()) throw new EmptyInputError("There is nothing to summarize yet.");
  return run(deps, summarizePrompt(input.transcript), { patientFacing: false, effort: "low" });
}

export async function ask(deps: Common, input: { transcript: string; question: string }): Promise<AiResult> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new EmptyInputError("Type a question first.");
  if (!input.transcript.trim()) throw new EmptyInputError("There is no conversation to ask about yet.");
  return run(deps, askPrompt(input.transcript, question), { patientFacing: false, effort: "low" });
}

export async function suggestReply(
  deps: Common,
  input: { transcript: string; passages: Passage[]; extraInstruction?: string },
): Promise<AiResult> {
  if (!input.transcript.trim()) throw new EmptyInputError("There is no conversation to reply to yet.");
  const extra = input.extraInstruction?.trim().slice(0, MAX_QUESTION_CHARS);
  return run(deps, suggestReplyPrompt(input.transcript, input.passages, { extraInstruction: extra }), {
    patientFacing: true,
    effort: "medium",
    // anything the draft cites must come from what the model was shown
    sourceText: [input.transcript, ...input.passages.map((p) => p.content), extra ?? ""].join("\n"),
    chunkIds: input.passages.map((p) => p.chunkId),
    extraFlags: input.passages.length
      ? []
      : ["No matching knowledge-base content was found. Check any facts before sending."],
  });
}

export async function rewrite(deps: Common, input: { draft: string; mode: RewriteMode }): Promise<AiResult> {
  const draft = input.draft.trim();
  if (!draft) throw new EmptyInputError("Write a message first.");
  return run(deps, rewritePrompt(draft.slice(0, MAX_DRAFT_CHARS), input.mode), {
    patientFacing: true,
    effort: "low",
    sourceText: draft, // a rewrite must not introduce links or numbers the staff member did not write
  });
}
