import { maskContactDetails } from "@/lib/ai/context";
import { EmptyInputError } from "@/lib/ai/features";
import type { Llm } from "@/lib/ai/llm";
import type { CopilotCall } from "@/lib/ai/flow-copilot/generate";
import {
  validateAudienceOutput,
  type CatalogueField,
  type AudienceValidation,
  type OptionSets,
} from "@/lib/ai/campaign-copilot/audience";
import {
  audienceRepairPrompt,
  audienceSystemPrompt,
  audienceUserPrompt,
} from "@/lib/ai/campaign-copilot/prompt";
import type { FieldRegistry } from "@/lib/filters/field-registry";

export const MAX_AUDIENCE_REQUEST_CHARS = 600;

export type GenerateAudienceResult =
  | (Extract<AudienceValidation, { ok: true }> & { repaired: boolean; calls: CopilotCall[] })
  | { ok: false; errors: string[]; refused: boolean; declined: boolean; calls: CopilotCall[] };

/** Same shape as the Flow Copilot: one call, validate, repair once with the validator's errors, then reject. */
export async function generateAudience(
  deps: { llm: Llm; clinicName?: string; now?: () => number },
  input: {
    request: string;
    catalogue: readonly CatalogueField[];
    registry: FieldRegistry;
    sets: OptionSets;
    timezone: string;
    today: string;
  },
): Promise<GenerateAudienceResult> {
  const request = maskContactDetails(input.request.trim()).slice(0, MAX_AUDIENCE_REQUEST_CHARS);
  if (!request) throw new EmptyInputError("Describe the audience first.");
  const now = deps.now ?? Date.now;
  const system = audienceSystemPrompt({
    clinicName: deps.clinicName,
    today: input.today,
    timezone: input.timezone,
  });
  const ctx = { registry: input.registry, sets: input.sets, timezone: input.timezone };
  const calls: CopilotCall[] = [];

  async function ask(user: string) {
    const started = now();
    const res = await deps.llm.complete({ system, user, maxTokens: 3000, effort: "low" });
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

  const first = await ask(audienceUserPrompt(request, input.catalogue));
  if (first.refused)
    return {
      ok: false,
      errors: ["The assistant could not help with that request."],
      refused: true,
      declined: false,
      calls,
    };
  const v1 = validateAudienceOutput(first.text, ctx);
  if (v1.ok) return { ...v1, repaired: false, calls };
  if (v1.declined) return { ok: false, errors: v1.errors, refused: false, declined: true, calls };

  calls[0] = { ...calls[0]!, status: "needs_review" };
  const second = await ask(
    audienceRepairPrompt(request, input.catalogue, first.text.slice(0, 10_000), v1.errors),
  );
  if (second.refused)
    return { ok: false, errors: v1.errors, refused: false, declined: false, calls };
  const v2 = validateAudienceOutput(second.text, ctx);
  if (v2.ok) return { ...v2, repaired: true, calls };
  calls[calls.length - 1] = { ...calls[calls.length - 1]!, status: "needs_review" };
  return { ok: false, errors: v2.errors, refused: false, declined: !!v2.declined, calls };
}
