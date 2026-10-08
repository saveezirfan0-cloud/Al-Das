import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type AuditEntry = {
  orgId: string;
  userId: string | null;
  action: string; // 'role.created', 'user.invited', ...
  entity: string; // 'role', 'invite', 'membership', 'team', 'profile', 'org'
  entityId?: string | null;
  diff?: Json;
};

/** Append-only audit trail. Never put message bodies, tokens or full phone numbers in diff. */
export async function recordAudit(admin: AdminClient, entry: AuditEntry): Promise<void> {
  const { error } = await admin.from("audit_log").insert({
    org_id: entry.orgId,
    user_id: entry.userId,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    diff: entry.diff ?? null,
  });
  if (error) {
    // Auditing must never break the main action, but it must be visible.
    console.error("[audit] insert failed", { action: entry.action, code: error.code });
  }
}
