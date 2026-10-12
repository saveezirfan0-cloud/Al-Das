import "server-only";

import { AiProviderError, createAnthropicLlm, type Llm } from "@/lib/ai/llm";
import type { CopilotCall } from "@/lib/ai/flow-copilot/generate";
import { readAiSettings, type AiSettings } from "@/lib/ai/settings";
import { AiNotConfiguredError, type AiFeature } from "@/lib/ai/types";
import { checkRateLimit, countExtraCall, recordUsage } from "@/lib/ai/usage";
import type { CurrentMember } from "@/lib/auth/session";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * What every copilot server action does before it may call the model. The caller has ALREADY run requirePerm / can for the
 * feature's own permissions (the static security audit wants that in the action itself); this adds the organisation-level
 * gates that are the same everywhere: the AI master switch (OFF by default), the per-person limit, the workspace daily cap,
 * and the provider key. Each failure is a plain sentence for the person; nothing is thrown.
 */
export type OpenedCopilot = {
  admin: AdminClient;
  llm: Llm;
  clinicName: string;
  settings: AiSettings;
};

export async function openCopilot(
  member: CurrentMember,
): Promise<({ ok: true } & OpenedCopilot) | { ok: false; error: string }> {
  const settings = readAiSettings(member.org.settings);
  if (!settings.enabled)
    return {
      ok: false,
      error:
        "AI is turned off for this workspace. An administrator can turn it on in Settings, AI & knowledge base.",
    };
  const admin = createAdminClient();
  const limit = await checkRateLimit(
    admin,
    member.orgId,
    member.userId,
    settings.rate_limit_per_minute,
    settings.daily_cap,
  );
  if (!limit.allowed)
    return {
      ok: false,
      error:
        limit.reason === "daily"
          ? "Your workspace has reached its daily AI limit. It resets tomorrow; an admin can raise it in Settings, AI & knowledge base."
          : "You are using AI very quickly. Wait a few seconds and try again.",
    };
  let llm: Llm;
  try {
    llm = createAnthropicLlm();
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, admin, llm, clinicName: member.org.name, settings };
}

/** One ai_usage row per model call: tokens, time and outcome. Never a prompt, a reply or any patient text. */
export async function recordCalls(
  opened: Pick<OpenedCopilot, "admin" | "settings">,
  member: CurrentMember,
  feature: AiFeature,
  calls: readonly CopilotCall[],
): Promise<void> {
  for (const [i, call] of calls.entries()) {
    if (i > 0) await countExtraCall(opened.admin, member.orgId, opened.settings.daily_cap);
    await recordUsage(opened.admin, {
      orgId: member.orgId,
      userId: member.userId,
      conversationId: null,
      feature,
      model: call.model,
      status: call.status,
      result: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        latencyMs: call.latencyMs,
      },
    });
  }
}

/** A provider failure becomes a plain message; anything else is logged by NAME only (the message could echo a prompt). */
export function describeProviderFailure(err: unknown, feature: string): string {
  if (err instanceof AiProviderError) return err.message;
  console.error("[ai] unexpected copilot failure", {
    feature,
    error: err instanceof Error ? err.name : "unknown",
  });
  return "The AI assistant hit a problem. Please try again.";
}
