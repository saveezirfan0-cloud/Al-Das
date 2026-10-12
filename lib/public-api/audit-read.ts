import "server-only";

import { recordAudit } from "@/lib/audit";
import type { ApiKeyContext } from "@/lib/public-api/auth";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Reads of patient data through the public API are audited, but sampled: one row per API key and
 * resource per window, carrying how many records that first request returned. An integration polling
 * every few seconds would otherwise bury the audit log, and the row still answers the question that
 * matters ("which key read contacts, and when did it start"). Best effort: auditing must never fail a read.
 */
export const READ_AUDIT_WINDOW_MS = 15 * 60_000;

export type ReadResource = "contacts" | "appointments" | "enquiries";

export async function auditApiRead(admin: AdminClient, ctx: ApiKeyContext, resource: ReadResource, count: number, now = new Date()): Promise<void> {
  try {
    const action = `api.${resource}_read`;
    const since = new Date(now.getTime() - READ_AUDIT_WINDOW_MS).toISOString();
    const { data } = await admin
      .from("audit_log")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("action", action)
      .eq("diff->>api_key_id", ctx.keyId)
      .gte("created_at", since)
      .limit(1);
    if (data && data.length > 0) return;
    await recordAudit(admin, { orgId: ctx.orgId, userId: null, action, entity: resource, diff: { api_key_id: ctx.keyId, records: count, sampled_window_minutes: READ_AUDIT_WINDOW_MS / 60_000 } });
  } catch (err) {
    console.error("[public-api] read audit failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}
