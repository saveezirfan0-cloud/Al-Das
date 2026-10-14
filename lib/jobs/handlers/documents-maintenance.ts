import { formatInTimeZone } from "date-fns-tz";

import { REMINDER_CATEGORIES } from "@/lib/documents/categories";
import { addDays, dueForExpiryReminder, expiryTaskDue } from "@/lib/documents/expiry";
import { readDocumentSettings } from "@/lib/documents/settings";
import {
  deleteDocumentsWithFiles,
  findPastRetention,
  loadRetentionPolicies,
} from "@/lib/documents/server";
import {
  LIBRARY_BUCKET,
  DOCUMENT_BUCKET,
  FINANCE_DOCUMENT_BUCKET,
  libraryObjectPath,
} from "@/lib/media/paths";
import { removeObjects } from "@/lib/media/probe";
import { recordAudit } from "@/lib/audit";
import { registerTask } from "@/lib/jobs/tasks";
import type { JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * /api/jobs/documents_maintenance (pg_cron daily, 03:40 UTC): upkeep for the Media Library and patient documents.
 *
 *   1. Uploads that never finished (status 'pending' for more than a day) are removed, bytes and row.
 *   2. Insurance cards inside their reminder window (Settings, Patient documents) raise ONE notification per
 *      organisation per run to the people who manage documents, and a follow-up task on each patient. The reminder is
 *      claimed with an atomic update of `expiry_notified_at`, so a retry or an overlapping run never reminds twice.
 *      Push and e-mail carry no names (lib/notify/push-payload.ts); the task subject names no one either.
 *   3. Documents past their category's retention period are deleted ONLY where the policy has automatic deletion on.
 *
 * Counts only are logged: never a title, a path or a patient.
 */
registerTask("documents_maintenance", {
  name: "documents.maintenance",
  run: (admin, log) => runDocumentsMaintenance(admin, log),
});

export type MaintenanceTotals = {
  orgs: number;
  abandoned_removed: number;
  reminders: number;
  tasks_created: number;
  retention_deleted: number;
};

const ABANDONED_AFTER_MS = 24 * 3_600_000;
const PAGE = 200;

export async function runDocumentsMaintenance(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<MaintenanceTotals> {
  const totals: MaintenanceTotals = {
    orgs: 0,
    abandoned_removed: 0,
    reminders: 0,
    tasks_created: 0,
    retention_deleted: 0,
  };

  // 1. Unfinished uploads, all organisations.
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS).toISOString();
  const { data: staleAssets } = await admin
    .from("media_assets")
    .select("id, org_id, storage_path")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .limit(PAGE);
  for (const a of staleAssets ?? []) {
    const ok = await removeObjects(admin, LIBRARY_BUCKET, [
      a.storage_path,
      libraryObjectPath(a.org_id, a.id, "thumb"),
    ]);
    if (!ok) continue;
    const { error } = await admin
      .from("media_assets")
      .delete()
      .eq("id", a.id)
      .eq("status", "pending");
    if (!error) totals.abandoned_removed++;
  }
  const { data: staleDocs } = await admin
    .from("patient_documents")
    .select("id, storage_path")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .limit(PAGE);
  for (const d of staleDocs ?? []) {
    if (!(await removeObjects(admin, DOCUMENT_BUCKET, [d.storage_path]))) continue;
    const { error } = await admin
      .from("patient_documents")
      .delete()
      .eq("id", d.id)
      .eq("status", "pending");
    if (!error) totals.abandoned_removed++;
  }
  // Finance documents (Phase 20D) follow the same rule.
  const { data: staleFinance } = await admin
    .from("fin_documents")
    .select("id, storage_path")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .limit(PAGE);
  for (const d of staleFinance ?? []) {
    if (!(await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [d.storage_path]))) continue;
    const { error } = await admin.from("fin_documents").delete().eq("id", d.id).eq("status", "pending");
    if (!error) totals.abandoned_removed++;
  }

  // 2 and 3, per organisation.
  const { data: orgs } = await admin.from("orgs").select("id, timezone, settings");
  for (const org of orgs ?? []) {
    totals.orgs++;
    const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");
    const settings = readDocumentSettings(org.settings);

    const horizon = addDays(today, settings.expiry_lead_days);
    if (horizon) {
      const { data: candidates } = await admin
        .from("patient_documents")
        .select("id, contact_id, category, expires_on, expiry_notified_at")
        .eq("org_id", org.id)
        .eq("status", "ready")
        .in("category", [...REMINDER_CATEGORIES])
        .is("expiry_notified_at", null)
        .not("expires_on", "is", null)
        .lte("expires_on", horizon)
        .order("expires_on")
        .limit(PAGE);
      const due = dueForExpiryReminder(candidates ?? [], today, settings.expiry_lead_days);
      const claimed: Array<{ id: string; contact_id: string; expires_on: string }> = [];
      for (const d of due) {
        // Atomic claim: only the run that flips the flag raises the reminder.
        const { data: won } = await admin
          .from("patient_documents")
          .update({ expiry_notified_at: now.toISOString() })
          .eq("id", d.id)
          .is("expiry_notified_at", null)
          .select("id")
          .maybeSingle();
        if (won && d.expires_on)
          claimed.push({ id: d.id, contact_id: d.contact_id, expires_on: d.expires_on });
      }
      if (claimed.length > 0) {
        totals.reminders += claimed.length;
        let firstTask: string | null = null;
        if (settings.expiry_task) {
          for (const c of claimed) {
            const { data: task } = await admin
              .from("tasks")
              .insert({
                org_id: org.id,
                type: "follow_up",
                subject: "Insurance card expiring: check the patient's cover",
                due_at: expiryTaskDue(c.expires_on, now).toISOString(),
                contact_id: c.contact_id,
              })
              .select("id")
              .single();
            if (task) {
              totals.tasks_created++;
              firstTask ??= task.id;
            }
          }
        }
        const recipients = await memberIdsWithPermission(admin, org.id, "documents.manage");
        const single = claimed.length === 1 ? claimed[0] : null;
        await notify(admin, {
          orgId: org.id,
          userIds: recipients,
          event: "document.expiring",
          type: "document.expiring",
          title: single
            ? "An insurance card is about to expire"
            : `${claimed.length} insurance cards are about to expire`,
          body: single
            ? "Open the patient's Documents tab to see which card."
            : "Open Tasks to see the follow-ups.",
          payload: (single
            ? { contact_id: single.contact_id, document_id: single.id }
            : { count: claimed.length }) as NonNullable<Json>,
          ids: { task_id: firstTask },
        });
      }
    }

    const policies = await loadRetentionPolicies(admin, org.id);
    if (policies.some((p) => p.auto_delete)) {
      const past = await findPastRetention(admin, org.id, policies, today, PAGE);
      if (past.autoDelete.length > 0) {
        const deleted = await deleteDocumentsWithFiles(admin, org.id, past.autoDelete);
        totals.retention_deleted += deleted;
        if (deleted > 0)
          await recordAudit(admin, {
            orgId: org.id,
            userId: null,
            action: "documents.retention_deleted",
            entity: "patient_document",
            diff: { deleted, attempted: past.autoDelete.length } as Json,
          });
      }
    }
  }

  log.info("documents maintenance done", totals);
  return totals;
}
