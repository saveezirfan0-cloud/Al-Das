import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { recordAudit } from "@/lib/audit";
import { dueForDeadlineReminder } from "@/lib/finance/denials";
import {
  dueForExpiryTask,
  PREAUTH_TASK_SUBJECT,
  pastExpiry,
  reminderHorizon,
  taskDueAt,
} from "@/lib/finance/preauth";
import { runFollowupTasks } from "@/lib/finance/followup-server";
import { runRecovery } from "@/lib/finance/recovery-server";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import type { JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * /api/jobs/finance_workflows (pg_cron daily, 03:50 UTC): the Phase 18 upkeep. It NEVER calls Unite or any payer; it reads
 * what is already stored.
 *
 *   1. Pre-authorisations: past their expiry -> status 'expired'; approved ones inside the lead window are reminded ONCE
 *      (atomic claim of expiry_notified_at): a task on the patient and one notification to the people who manage them.
 *   2. Denials: cases are opened / refreshed / recovered from the Diligence claims (fin_sync_denial_cases, only once
 *      finance set a start date); cases inside the warning window of their deadline are reminded once.
 *   3. Self-pay reminders, only when finance switched them on (and approved the wording).
 *   4. Insurance follow-up (Phase 20I): each unpaid claim that crossed a follow-up stage (60 / 90 / 120 days by default)
 *      since finance set a start date gets ONE task per stage, claimed atomically in fin_followup_create_tasks.
 *
 * Notifications and task subjects are fixed generic sentences: no names, numbers or amounts. Counts only are logged.
 */

export type WorkflowTotals = {
  orgs: number;
  preauth_expired: number;
  preauth_linked: number;
  preauth_reminders: number;
  preauth_tasks: number;
  denial_opened: number;
  denial_recovered: number;
  denial_reminders: number;
  denial_tasks: number;
  recovery_queued: number;
  recovery_failed: number;
  followup_raised: number;
  followup_tasks: number;
  followup_closed: number;
};

const PAGE = 200;

export async function runFinanceWorkflows(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<WorkflowTotals> {
  const totals: WorkflowTotals = {
    orgs: 0,
    preauth_expired: 0,
    preauth_linked: 0,
    preauth_reminders: 0,
    preauth_tasks: 0,
    denial_opened: 0,
    denial_recovered: 0,
    denial_reminders: 0,
    denial_tasks: 0,
    recovery_queued: 0,
    recovery_failed: 0,
    followup_raised: 0,
    followup_tasks: 0,
    followup_closed: 0,
  };
  const { data: orgs } = await admin.from("orgs").select("id, name, timezone");
  for (const org of orgs ?? []) {
    totals.orgs++;
    try {
      await oneOrg(admin, org, now, totals, log);
    } catch (err) {
      // one organisation's failure must not stop the others; the name only, never the message (it may echo data)
      log.error("finance workflows failed for an organisation", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  log.info("finance workflows done", totals);
  return totals;
}

async function oneOrg(
  admin: AdminClient,
  org: { id: string; name: string; timezone: string | null },
  now: Date,
  totals: WorkflowTotals,
  log: JobLogger,
) {
  const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");
  const settings = await loadFinanceSettings(admin, org.id);

  // ---- 1. pre-authorisations ------------------------------------------------------------------
  const { data: expiring } = await admin
    .from("fin_pre_authorisations")
    .select("id, status, expires_on, expiry_notified_at, contact_id")
    .eq("org_id", org.id)
    .in("status", ["approved", "partially_approved"])
    .not("expires_on", "is", null)
    .lte("expires_on", reminderHorizon(today, settings.preauthExpiryLeadDays) ?? today)
    .order("expires_on")
    .limit(PAGE);

  const past = pastExpiry(expiring ?? [], today);
  for (const p of past) {
    const { data: won } = await admin
      .from("fin_pre_authorisations")
      .update({ status: "expired" })
      .eq("id", p.id)
      .in("status", ["approved", "partially_approved"])
      .select("id")
      .maybeSingle();
    if (won) totals.preauth_expired++;
  }
  const linked = await admin.rpc("fin_link_preauth_claims", { p_org_id: org.id });
  totals.preauth_linked += Number(linked.data ?? 0);

  const due = dueForExpiryTask(expiring ?? [], today, settings.preauthExpiryLeadDays);
  const claimed: Array<{ id: string; contact_id: string | null; expires_on: string }> = [];
  for (const p of due) {
    const { data: won } = await admin
      .from("fin_pre_authorisations")
      .update({ expiry_notified_at: now.toISOString() })
      .eq("id", p.id)
      .is("expiry_notified_at", null)
      .select("id")
      .maybeSingle();
    if (won && p.expires_on)
      claimed.push({
        id: p.id,
        contact_id: (p as { contact_id: string | null }).contact_id,
        expires_on: p.expires_on,
      });
  }
  if (claimed.length > 0) {
    totals.preauth_reminders += claimed.length;
    let firstTask: string | null = null;
    if (settings.preauthTaskEnabled) {
      for (const c of claimed) {
        const { data: task } = await admin
          .from("tasks")
          .insert({
            org_id: org.id,
            type: "follow_up",
            subject: PREAUTH_TASK_SUBJECT,
            due_at: taskDueAt(c.expires_on, now).toISOString(),
            contact_id: c.contact_id,
          })
          .select("id")
          .single();
        if (task) {
          totals.preauth_tasks++;
          firstTask ??= task.id;
          await admin
            .from("fin_pre_authorisations")
            .update({ expiry_task_id: task.id })
            .eq("id", c.id);
        }
      }
    }
    await notify(admin, {
      orgId: org.id,
      userIds: await memberIdsWithPermission(admin, org.id, "finance.preauth.manage"),
      event: "finance.preauth_expiring",
      type: "finance.preauth_expiring",
      title:
        claimed.length === 1
          ? "A pre-authorisation is about to expire"
          : `${claimed.length} pre-authorisations are about to expire`,
      body: "Open Finance, Pre-authorisations to see which.",
      payload: { count: claimed.length } as NonNullable<Json>,
      ids: { task_id: firstTask },
    });
  }

  // ---- 2. denial cases -------------------------------------------------------------------------
  const sync = await admin.rpc("fin_sync_denial_cases", { p_org_id: org.id, p_limit: 1000 });
  const syncResult = (sync.data ?? {}) as { opened?: number; recovered?: number };
  totals.denial_opened += Number(syncResult.opened ?? 0);
  totals.denial_recovered += Number(syncResult.recovered ?? 0);
  if (Number(syncResult.opened ?? 0) > 0)
    await recordAudit(admin, {
      orgId: org.id,
      userId: null,
      action: "finance.denials.synced",
      entity: "ins_denial_cases",
      diff: { opened: syncResult.opened ?? 0, recovered: syncResult.recovered ?? 0 } as Json,
    });

  if (settings.denialCasesStartDate) {
    const { data: live } = await admin
      .from("ins_denial_cases")
      .select("id, status, deadline_on, deadline_notified_at, owner_user_id, appealable")
      .eq("org_id", org.id)
      .in("status", ["open", "in_progress"])
      .is("deadline_notified_at", null)
      .order("deadline_on")
      .limit(PAGE);
    const dueCases = dueForDeadlineReminder(live ?? [], today, settings.denialWarnDays);
    const won: Array<{ id: string; owner_user_id: string | null; deadline_on: string }> = [];
    for (const d of dueCases) {
      const { data: claim } = await admin
        .from("ins_denial_cases")
        .update({ deadline_notified_at: now.toISOString() })
        .eq("id", d.id)
        .is("deadline_notified_at", null)
        .select("id")
        .maybeSingle();
      if (claim) won.push({ id: d.id, owner_user_id: d.owner_user_id, deadline_on: d.deadline_on });
    }
    if (won.length > 0) {
      totals.denial_reminders += won.length;
      if (settings.denialTaskEnabled) {
        for (const d of won) {
          const { data: task } = await admin
            .from("tasks")
            .insert({
              org_id: org.id,
              type: "follow_up",
              subject: "Denied claim: resubmission deadline is close",
              due_at: now.toISOString(),
              assignee_id: d.owner_user_id,
            })
            .select("id")
            .single();
          if (task) {
            totals.denial_tasks++;
            await admin.from("ins_denial_cases").update({ task_id: task.id }).eq("id", d.id);
          }
        }
      }
      await notify(admin, {
        orgId: org.id,
        userIds: await memberIdsWithPermission(admin, org.id, "finance.denials.manage"),
        event: "finance.denial_deadline",
        type: "finance.denial_deadline",
        title:
          won.length === 1
            ? "A denied claim is close to its deadline"
            : `${won.length} denied claims are close to their deadline`,
        body: "Open Finance, Denials to see which.",
        payload: { count: won.length } as NonNullable<Json>,
      });
    }
  }

  // ---- 4. insurance follow-up (off until finance sets a start date) --------------------------------
  // Runs before the reminders so a reminder failure cannot hold it back; its own failure is contained here.
  try {
    const fu = await runFollowupTasks(admin, org.id, today, now);
    totals.followup_raised += fu.raised;
    totals.followup_tasks += fu.tasks;
    totals.followup_closed += fu.closed;
    if (fu.raised > 0 || fu.closed > 0)
      await recordAudit(admin, {
        orgId: org.id,
        userId: null,
        action: "finance.followup.tasks_raised",
        entity: "ins_claim_followup_stages",
        diff: {
          raised: fu.raised,
          tasks: fu.tasks,
          superseded: fu.superseded,
          unassigned: fu.unassigned,
          closed: fu.closed,
        } as Json,
      });
  } catch (err) {
    log.error("insurance follow-up step failed for an organisation", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  // ---- 3. self-pay reminders (switched off unless finance enabled them) --------------------------
  if (settings.recovery.enabled) {
    const res = await runRecovery(admin, org.id, {
      actorId: null,
      dryRun: false,
      clinicName: org.name,
      now,
    });
    totals.recovery_queued += res.queued;
    totals.recovery_failed += res.failed;
    if (res.queued > 0 || res.failed > 0)
      await recordAudit(admin, {
        orgId: org.id,
        userId: null,
        action: "finance.recovery.run",
        entity: "fin_recovery_reminders",
        diff: { queued: res.queued, failed: res.failed, skipped: res.skipped } as Json,
      });
  }
}
