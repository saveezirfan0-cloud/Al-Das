import { formatInTimeZone } from "date-fns-tz";

import type { AiFeature, AiResult, AiStatus } from "@/lib/ai/types";
import { checkRateLimit as checkWindow } from "@/lib/rate-limit";
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

/** Calendar day in the workspace timezone, "2026-10-12": the key the daily counter is stored under. */
export function aiDayKey(now: Date, timeZone: string): string {
  try {
    return formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  } catch {
    return formatInTimeZone(now, "UTC", "yyyy-MM-dd");
  }
}

/**
 * Workspace-wide daily cap on AI calls. Uses the same atomic Postgres counter as the other rate limits
 * (public.rate_limit_hit), reserving a call BEFORE it is made, so two requests in flight cannot both slip
 * under the cap. Attempts that later fail still count: the cap bounds spend, not successes. If the counter
 * itself is unavailable the call is allowed (a counting failure must not lock staff out of the inbox).
 */
export async function checkDailyCap(
  admin: AdminClient,
  orgId: string,
  cap: number,
  timeZone: string,
  now = new Date(),
): Promise<{ allowed: boolean }> {
  const r = await checkWindow(admin, "ai-daily", `${orgId}:${aiDayKey(now, timeZone)}`, {
    limit: cap,
    windowSec: 86_400,
    failOpen: true,
  });
  return { allowed: r.allowed };
}
