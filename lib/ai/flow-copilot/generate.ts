import { maskContactDetails } from "@/lib/ai/context";
import { EmptyInputError } from "@/lib/ai/features";
import type { Llm } from "@/lib/ai/llm";
import { AI_FLOW_LIMITS } from "@/lib/ai/flow-copilot/policy";
import { flowRepairPrompt, flowSystemPrompt, flowUserPrompt } from "@/lib/ai/flow-copilot/prompt";
import {
  validateCopilotOutput,
  type CopilotLookups,
  type FlowValidation,
} from "@/lib/ai/flow-copilot/validate";
import type { AiStatus } from "@/lib/ai/types";

/** What one model call cost: tokens and time only. Never the text. */
export type CopilotCall = {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  status: AiStatus;
};

export type GenerateFlowResult =
  | (Extract<FlowValidation, { ok: true }> & { repaired: boolean; calls: CopilotCall[] })
  | { ok: false; errors: string[]; refused: boolean; calls: CopilotCall[] };

const REPAIR_ECHO_CHARS = 20_000;

/**
 * Asks the model for a flow, validates it, and repairs it AT MOST ONCE by feeding the validator's errors back. A second
 * failure is final: the person sees the reasons and nothing is created. Pure orchestration over an injected `Llm`.
 */
export async function generateFlow(
  deps: { llm: Llm; clinicName?: string; now?: () => number },
  input: { request: string; lookups: CopilotLookups },
): Promise<GenerateFlowResult> {
  const request = maskContactDetails(input.request.trim()).slice(0, AI_FLOW_LIMITS.maxPromptChars);
  if (!request) throw new EmptyInputError("Describe what the bot should do first.");
  const now = deps.now ?? Date.now;
  const system = flowSystemPrompt({ clinicName: deps.clinicName });
  const calls: CopilotCall[] = [];

  async function ask(user: string): Promise<{ text: string; refused: boolean }> {
    const started = now();
    const res = await deps.llm.complete({ system, user, maxTokens: 8192, effort: "medium" });
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

  const first = await ask(flowUserPrompt(request));
  if (first.refused)
    return {
      ok: false,
      errors: ["The assistant could not help with that request."],
      refused: true,
      calls,
    };
  const v1 = validateCopilotOutput(first.text, input.lookups);
  if (v1.ok) return { ...v1, repaired: false, calls };

  calls[0] = { ...calls[0]!, status: "needs_review" };
  const second = await ask(
    flowRepairPrompt(request, first.text.slice(0, REPAIR_ECHO_CHARS), v1.errors),
  );
  if (second.refused) return { ok: false, errors: v1.errors, refused: false, calls };
  const v2 = validateCopilotOutput(second.text, input.lookups);
  if (v2.ok) return { ...v2, repaired: true, calls };
  // Final: the reasons from the repaired attempt are the ones worth showing.
  calls[calls.length - 1] = { ...calls[calls.length - 1]!, status: "needs_review" };
  return { ok: false, errors: v2.errors, refused: false, calls };
}
