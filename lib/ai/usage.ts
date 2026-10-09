import type { AiFeature, AiResult, AiStatus } from "@/lib/ai/types";
import type { AdminClient } from "@/lib/supabase/admin";

/** ai_usage holds tokens, latency and outcome only. Never prompt or completion text. */

export async function recordUsage(
  admin: AdminClient,
  row: {
    orgId: string;
    userId: string;
    conversationId: string | null;
    feature: AiFeature;
    model: string;
    status: AiStatus;
    result?: Pick<AiResult, "inputTokens" | "outputTokens" | "latencyMs">;
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
    })
    .select("id")
    .single();
  if (error) {
    console.error("[ai] usage insert failed", { code: error.code });
    return null;
  }
  return data.id;
}

/** Sliding one-minute limit per user, counted from ai_usage. */
export async function checkRateLimit(
  admin: AdminClient,
  orgId: string,
  userId: string,
  perMinute: number,
  now = Date.now(),
): Promise<{ allowed: boolean }> {
  const since = new Date(now - 60_000).toISOString();
  const { count, error } = await admin
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) return { allowed: true }; // a counting failure must not lock staff out of the inbox
  return { allowed: (count ?? 0) < perMinute };
}
