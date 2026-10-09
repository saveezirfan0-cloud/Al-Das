import Anthropic from "@anthropic-ai/sdk";

import { aiEnv } from "@/lib/env";
import { AiNotConfiguredError } from "@/lib/ai/types";

/**
 * Thin seam over the Anthropic SDK so features can be tested with a fake and the model comes from
 * env (ANTHROPIC_MODEL), never hard-coded. Requests carry only the prompt text: nothing here logs it.
 */

export type LlmRequest = {
  system: string;
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
};

export type LlmResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** A safety classifier declined the request (and any server-side fallback declined too). */
  refused: boolean;
  /** The model that actually served the reply (differs from `model` after a fallback). */
  servedBy: string;
};

export interface Llm {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** The provider is down, rate limiting us, or rejected the request. `retryable` drives the UI hint. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** Models that accept `output_config.effort` (older ones 400 on it). */
export function supportsEffort(model: string): boolean {
  return /^claude-(sonnet-5|opus-5|opus-4-[678]|fable-5|mythos-5|haiku-5)/.test(model);
}

/** Models for which the server-side refusal fallback (`fallbacks: "default"`) is available. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(sonnet-5-5|opus-5-5|opus-5$|fable-5-1)/.test(model);
}

export function createAnthropicLlm(
  opts: { apiKey?: string; model?: string; client?: Anthropic } = {},
): Llm {
  const env = aiEnv();
  const apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  const model = opts.model ?? env.ANTHROPIC_MODEL;
  if (!opts.client && !apiKey) throw new AiNotConfiguredError("The AI provider (ANTHROPIC_API_KEY)");
  const client = opts.client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });

  return {
    model,
    async complete(req) {
      const base = {
        model,
        // Generous: adaptive thinking tokens count toward max_tokens.
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: "user" as const, content: req.user }],
        ...(req.effort && supportsEffort(model) ? { output_config: { effort: req.effort } } : {}),
      };
      try {
        // Refusal fallback is on by default where the model supports it: a classifier decline on a
        // routine clinic message is re-run on the fallback model inside the same call.
        const message = supportsServerFallback(model)
          ? await client.beta.messages.create({
              ...base,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            })
          : await client.messages.create(base);
        const text = message.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("")
          .trim();
        return {
          text,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          refused: message.stop_reason === "refusal",
          servedBy: message.model,
        };
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
          throw new AiProviderError("The AI service is busy. Try again in a moment.", true);
        }
        if (err instanceof Anthropic.AuthenticationError) {
          throw new AiProviderError("The AI provider rejected our credentials. Contact an administrator.", false);
        }
        if (err instanceof Anthropic.APIError) {
          // status only: never the message, which may echo request content
          throw new AiProviderError(`The AI service returned an error (${err.status ?? "unknown"}).`, (err.status ?? 500) >= 500);
        }
        throw err;
      }
    },
  };
}
