import "server-only";

import { holds } from "@/lib/finance/rules";
import { isBalanceStalled } from "@/lib/finance/health";
import { runAlerts, type AlertDeps, type AlertRunResult } from "@/lib/finance/run-alerts";
import type { AlertSnapshot, AlertState, Severity } from "@/lib/finance/alerts";
import { enqueue } from "@/lib/jobs/enqueue";
import { notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";

const PERM = "finance.capture.manage";

/** Service-role reads for the alert snapshot. Callers are the hourly job and a permission-checked page. */
export async function loadAlertSnapshot(admin: AdminClient, orgId: string): Promise<AlertSnapshot> {
  const today = new Date().toISOString().slice(0, 10);
  const [settings, success, pending, capEx, recent, upload, anyUpload, overdue] = await Promise.all(
    [
      admin
        .from("fin_capture_settings")
        .select("enabled, updated_at")
        .eq("org_id", orgId)
        .maybeSingle(),
      admin
        .from("fin_raw_unite_batches")
        .select("processed_at")
        .eq("org_id", orgId)
        .eq("process_status", "processed")
        .order("processed_at", { ascending: false })
        .limit(1),
      admin
        .from("fin_raw_unite_batches")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .neq("process_status", "processed"),
      admin
        .from("ops_exceptions")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("rule_code", "E09")
        .in("status", ["open", "in_progress"])
        .not("entity_key", "like", "gap:%"),
      admin
        .from("fin_raw_unite_batches")
        .select("record_count, balance_in_range")
        .eq("org_id", orgId)
        .order("requested_at", { ascending: false })
        .limit(6),
      admin
        .from("fin_raw_diligence_files")
        .select("committed_at")
        .eq("org_id", orgId)
        .eq("status", "committed")
        .order("committed_at", { ascending: false })
        .limit(1),
      admin
        .from("fin_raw_diligence_files")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "committed"),
      admin
        .from("ops_exceptions")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .in("status", ["open", "in_progress"])
        .lt("due_date", today),
    ],
  );

  return {
    captureEnabled: settings.data?.enabled ?? false,
    settingsUpdatedAt: settings.data?.updated_at ?? new Date().toISOString(),
    lastSuccessfulCaptureAt: success.data?.[0]?.processed_at ?? null,
    failedOrPendingBatches: pending.count ?? 0,
    openCaptureExceptions: capEx.count ?? 0,
    balanceStalled: isBalanceStalled(
      (recent.data ?? []).map((b) => ({
        recordCount: b.record_count,
        balanceInRange: b.balance_in_range,
      })),
    ),
    lastDiligenceUploadAt: upload.data?.[0]?.committed_at ?? null,
    everUploaded: (anyUpload.count ?? 0) > 0,
    overdueExceptions: overdue.count ?? 0,
  };
}

async function recipients(admin: AdminClient, orgId: string): Promise<string[]> {
  const { data } = await admin
    .from("memberships")
    .select("roles(permissions), profiles(email)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (data ?? []).flatMap((m) => {
    const perms = Array.isArray(m.roles?.permissions)
      ? (m.roles.permissions as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    return m.profiles?.email && holds(perms, PERM) ? [m.profiles.email] : [];
  });
}

export function dbAlertDeps(admin: AdminClient, orgId: string): AlertDeps {
  return {
    now: () => new Date(),
    loadSnapshot: () => loadAlertSnapshot(admin, orgId),
    loadState: async () => {
      const { data, error } = await admin
        .from("fin_alert_state")
        .select("alert_key, severity, first_seen_at, last_notified_at, cleared_at")
        .eq("org_id", orgId);
      if (error) throw new Error(`load alert state: ${error.message}`);
      return (data ?? []).map((r) => ({ ...r, severity: r.severity as Severity })) as AlertState[];
    },
    saveState: async (rows) => {
      const { error } = await admin.from("fin_alert_state").upsert(
        rows.map((r) => ({ ...r, org_id: orgId })),
        { onConflict: "org_id,alert_key" },
      );
      if (error) throw new Error(`save alert state: ${error.message}`);
    },
    notifyInApp: async (n) => {
      await notifyMembersWithPermission(admin, orgId, PERM, {
        type: "finance.alert",
        title: n.title,
        body: n.body,
        payload: { key: n.key, severity: n.severity },
      });
    },
    notifyEmail: async (n) => {
      for (const to of await recipients(admin, orgId))
        await enqueue("notifications", { type: "email", to, subject: n.subject, text: n.text });
    },
  };
}

export const runAlertsForOrg = (admin: AdminClient, orgId: string): Promise<AlertRunResult> =>
  runAlerts(dbAlertDeps(admin, orgId));
