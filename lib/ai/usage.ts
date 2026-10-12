import type { AiFeature, AiResult, AiStatus } from "@/lib/ai/types";
import { checkRateLimit as checkLimit } from "@/lib/rate-limit";
import type { AdminClient } from "@/lib/supabase/admin";

/** ai_usage holds tokens, latency and outcome only. Never prompt or completion text. */

export async function recordUsage(
  admin: AdminClient,
  row: {
    orgId: string;
    /** null for background work (intent detection) that no person started. */
    userId: string | null;
    conversationId: string | null;
    feature: AiFeature;
    model: string;
    status: AiStatus;
    result?: Pick<AiResult, "inputTokens" | "outputTokens" | "latencyMs">;
    /** suggest_reply only: whether knowledge-base passages were found. A flag, never content. */
    grounded?: boolean | null;
  },
): Promise<string | null> {
  const { data, error } = await admin
    .from("ai_usage")
    .insert({
      org_id: row.orgId,
      user_id: row.userId,
      conversation_id: row.conversationId,
      feature: row.feature,
      model: row.model,
      status: row.status,
      input_tokens: row.result?.inputTokens ?? 0,
      output_tokens: row.result?.outputTokens ?? 0,
      latency_ms: row.result?.latencyMs ?? 0,
      grounded: row.grounded ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[ai] usage insert failed", { code: error.code });
    return null;
  }
  return data.id;
}

/**
 * Per-user limit per minute plus a workspace-wide daily cap. Both use the atomic Postgres counter from
 * lib/rate-limit.ts, which increments in the same statement it checks, so parallel requests cannot all
 * slip under the limit the way a count-then-call check allowed. A counter failure fails open: it must
 * not lock staff out of the inbox.
 */
export async function checkRateLimit(
  admin: AdminClient,
  orgId: string,
  userId: string,
  perMinute: number,
  dailyCap = 0,
): Promise<{ allowed: boolean; reason?: "minute" | "daily" }> {
  const minute = await checkLimit(admin, "ai-user", `${orgId}:${userId}`, { limit: perMinute, windowSec: 60, failOpen: true });
  if (!minute.allowed) return { allowed: false, reason: "minute" };
  if (dailyCap > 0) {
    const day = await checkLimit(admin, "ai-org-day", orgId, { limit: dailyCap, windowSec: 86_400, failOpen: true });
    if (!day.allowed) return { allowed: false, reason: "daily" };
  }
  return { allowed: true };
}

/**
 * A second model call inside one feature (the single repair attempt) is a call like any other: it counts toward the
 * workspace's daily cap. The per-minute limit is not charged again; one button press is one request.
 */
export async function countExtraCall(admin: AdminClient, orgId: string, dailyCap: number): Promise<void> {
  if (dailyCap > 0) await checkLimit(admin, "ai-org-day", orgId, { limit: dailyCap, windowSec: 86_400, failOpen: true });
}

/** Background work (intent detection) has no person to rate-limit: only the workspace's daily cap applies. */
export async function checkOrgDailyCap(admin: AdminClient, orgId: string, dailyCap: number): Promise<boolean> {
  if (dailyCap <= 0) return true;
  const day = await checkLimit(admin, "ai-org-day", orgId, { limit: dailyCap, windowSec: 86_400, failOpen: true });
  return day.allowed;
}
