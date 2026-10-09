import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { AiProviderError, createAnthropicLlm, supportsEffort, supportsServerFallback } from "@/lib/ai/llm";
import { AiNotConfiguredError } from "@/lib/ai/types";

function fakeClient(response: Record<string, unknown> | Error) {
  const reply = async () => {
    if (response instanceof Error) throw response;
    return response;
  };
  const create = vi.fn<(arg: unknown) => Promise<unknown>>(reply);
  const betaCreate = vi.fn<(arg: unknown) => Promise<unknown>>(reply);
  return { client: { messages: { create }, beta: { messages: { create: betaCreate } } } as unknown as Anthropic, create, betaCreate };
}

const ok = {
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: "Hello " },
    { type: "text", text: "there" },
  ],
  usage: { input_tokens: 12, output_tokens: 7 },
  stop_reason: "end_turn",
  model: "claude-sonnet-5-5",
};

describe("model capability checks", () => {
  it("knows which models take effort and server-side fallbacks", () => {
    expect(supportsEffort("claude-sonnet-5-5")).toBe(true);
    expect(supportsEffort("claude-opus-5-5")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsServerFallback("claude-sonnet-5-5")).toBe(true);
    expect(supportsServerFallback("claude-opus-5-5")).toBe(true);
    expect(supportsServerFallback("claude-fable-5-1")).toBe(true);
    expect(supportsServerFallback("claude-sonnet-5")).toBe(false);
    expect(supportsServerFallback("claude-haiku-4-5")).toBe(false);
  });
});

describe("createAnthropicLlm", () => {
  it("uses the configured model, the fallback beta and effort; joins text blocks only", async () => {
    const { client, betaCreate, create } = fakeClient(ok);
    const llm = createAnthropicLlm({ client, model: "claude-sonnet-5-5" });
    const r = await llm.complete({ system: "sys", user: "hi", effort: "low" });

    expect(r).toEqual({ text: "Hello there", inputTokens: 12, outputTokens: 7, refused: false, servedBy: "claude-sonnet-5-5" });
    expect(create).not.toHaveBeenCalled();
    const args = betaCreate.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(args).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    // thinking is left to the model default, and no sampling params are sent
    expect(args).not.toHaveProperty("thinking");
    expect(args).not.toHaveProperty("temperature");
    expect(args.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it("uses the plain API and no effort for a model without fallbacks/effort support", async () => {
    const { client, betaCreate, create } = fakeClient({ ...ok, model: "claude-haiku-4-5" });
    const llm = createAnthropicLlm({ client, model: "claude-haiku-4-5" });
    await llm.complete({ system: "s", user: "u", effort: "medium" });
    expect(betaCreate).not.toHaveBeenCalled();
    const args = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(args).not.toHaveProperty("output_config");
    expect(args).not.toHaveProperty("fallbacks");
  });

  it("reports a refusal and which model served the reply after a fallback", async () => {
    const { client } = fakeClient({ ...ok, content: [], stop_reason: "refusal", model: "claude-opus-5-5" });
    const r = await createAnthropicLlm({ client, model: "claude-sonnet-5-5" }).complete({ system: "s", user: "u" });
    expect(r).toMatchObject({ text: "", refused: true, servedBy: "claude-opus-5-5" });
  });

  it("maps provider errors to friendly errors without leaking the provider message", async () => {
    const rate = Anthropic.APIError.generate(429, { error: { message: "patient text echoed" } }, "patient text echoed", new Headers());
    const e1 = await createAnthropicLlm({ client: fakeClient(rate).client, model: "claude-sonnet-5-5" })
      .complete({ system: "s", user: "u" })
      .catch((e) => e);
    expect(e1).toBeInstanceOf(AiProviderError);
    expect(e1.retryable).toBe(true);

    const auth = Anthropic.APIError.generate(401, {}, "bad key sk-ant-secret", new Headers());
    const e2 = await createAnthropicLlm({ client: fakeClient(auth).client, model: "claude-sonnet-5-5" })
      .complete({ system: "s", user: "u" })
      .catch((e) => e);
    expect(e2.retryable).toBe(false);
    expect(e2.message).not.toContain("sk-ant-secret");

    const server = Anthropic.APIError.generate(500, {}, "boom with body", new Headers());
    const e3 = await createAnthropicLlm({ client: fakeClient(server).client, model: "claude-sonnet-5-5" })
      .complete({ system: "s", user: "u" })
      .catch((e) => e);
    expect(e3.retryable).toBe(true);
    expect(e3.message).toContain("500");
    expect(e3.message).not.toContain("boom");
  });

  it("requires an API key when no client is injected", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createAnthropicLlm({ model: "claude-sonnet-5-5" })).toThrow(AiNotConfiguredError);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
