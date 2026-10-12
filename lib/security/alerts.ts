import "server-only";

import { notifyMembersWithPermission } from "@/lib/notifications";
import type { AlertDraft } from "@/lib/security/anomaly";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Raises a security alert once: security_alerts has a unique (org_id, dedupe_key), so a repeat of the
 * same event is dropped silently. New alerts go to everyone holding settings.manage through the normal
 * notifications table (realtime bell + the notifications queue). Summaries carry counts only.
 * Never throws: alerting must not break the action that triggered it.
 */
export async function raiseAlert(
  admin: AdminClient,
  orgId: string,
  draft: AlertDraft,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("security_alerts")
      .upsert(
        {
          org_id: orgId,
          kind: draft.kind,
          user_id: draft.userId,
          dedupe_key: draft.dedupeKey,
          summary: draft.summary,
          detail: draft.detail,
        },
        { onConflict: "org_id,dedupe_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) {
      console.error("[security] alert insert failed", { kind: draft.kind, code: error.code });
      return false;
    }
    const created = data?.[0];
    if (!created) return false; // already raised
    await notifyMembersWithPermission(admin, orgId, "settings.manage", {
      type: "security.alert",
      title: "Security alert",
      body: draft.summary,
      payload: { alert_id: created.id, kind: draft.kind },
    });
    return true;
  } catch (err) {
    console.error("[security] raiseAlert threw", {
      kind: draft.kind,
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}
