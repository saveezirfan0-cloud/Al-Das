import "server-only";

import { queueDocumentEmail } from "@/lib/finance/document-email-server";
import {
  REPORT_EMAIL_KINDS,
  runScheduledReports,
  type RecipientCandidate,
  type ReportEmailKind,
  type ReportRunPorts,
  type ReportRunTotals,
  type ScheduleRow,
} from "@/lib/finance/report-emails";
import { readFinanceAccess } from "@/lib/security/finance-access";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Scheduled report e-mails, the database side (service role, from the `finance_report_emails` task). The order and the
 * rules are in lib/finance/report-emails.ts (runScheduledReports); here are the reads, the SQL claim and the queue.
 * Each recipient becomes one `finance_document_email` job on the notifications queue: ids, the period and the SHA-256 of
 * the address only; that job re-reads the member, re-checks the permission and renders the report when it runs.
 */

const asKind = (k: string): ReportEmailKind | null =>
  (REPORT_EMAIL_KINDS as readonly string[]).includes(k) ? (k as ReportEmailKind) : null;

export function dbReportPorts(admin: AdminClient): ReportRunPorts {
  return {
    async schedules() {
      const { data, error } = await fetchAll((from, to) =>
        admin
          .from("fin_report_schedules")
          .select(
            "id, org_id, kind, enabled, send_time, day_of_month, recipient_ids, enabled_at, updated_by, created_by",
          )
          .eq("enabled", true)
          .order("id")
          .range(from, to),
      );
      if (error) throw new Error("schedules read failed");
      const out: ScheduleRow[] = [];
      for (const r of data) {
        const kind = asKind(r.kind);
        if (!kind) continue;
        out.push({
          id: r.id,
          orgId: r.org_id,
          kind,
          enabled: r.enabled,
          sendTime: r.send_time,
          dayOfMonth: r.day_of_month,
          enabledAt: r.enabled_at,
          recipientIds: r.recipient_ids ?? [],
          ownerId: r.updated_by ?? r.created_by ?? null,
        });
      }
      return out;
    },
    async org(orgId) {
      const { data } = await admin
        .from("orgs")
        .select("timezone, is_training, settings")
        .eq("id", orgId)
        .maybeSingle();
      if (!data) return null;
      return {
        timezone: data.timezone,
        isTraining: data.is_training === true,
        financeAccess: readFinanceAccess(data.settings),
      };
    },
    async claim(scheduleId, periodKey) {
      const { data, error } = await admin.rpc("fin_report_schedule_claim", {
        p_schedule_id: scheduleId,
        p_period_key: periodKey,
      });
      if (error) throw new Error("claim failed");
      return (data as string | null) ?? null;
    },
    async candidates(orgId, userIds) {
      if (userIds.length === 0) return [];
      const [{ data: members }, { data: people }] = await Promise.all([
        admin
          .from("memberships")
          .select("user_id, role_id, status, roles(permissions)")
          .eq("org_id", orgId)
          .in("user_id", [...userIds]),
        admin.from("profiles").select("id, email").in("id", [...userIds]),
      ]);
      return userIds.map((id): RecipientCandidate => {
        const m = (members ?? []).find((x) => x.user_id === id && x.status === "active");
        const perms = m?.roles?.permissions;
        return {
          userId: id,
          membership: m
            ? {
                roleId: m.role_id,
                status: m.status,
                permissions: Array.isArray(perms)
                  ? perms.filter((p): p is string => typeof p === "string")
                  : [],
              }
            : null,
          email: (people ?? []).find((p) => p.id === id)?.email ?? null,
          name: null,
        };
      });
    },
    async enqueue(job) {
      await queueDocumentEmail({
        orgId: job.orgId,
        userId: job.requestedBy,
        requestId: job.requestId,
        recipientEmail: job.recipientEmail,
        document:
          job.kind === "daily_flash"
            ? {
                kind: "daily_flash",
                day: job.periodKey,
                recipient_user_id: job.recipientUserId,
                run_id: job.runId,
              }
            : {
                kind: "monthly_summary",
                from: job.periodKey,
                to: job.periodKey,
                branch: null,
                recipient_user_id: job.recipientUserId,
                run_id: job.runId,
              },
      });
    },
    async finish(runId, result) {
      await admin
        .from("fin_report_schedule_runs")
        .update({
          status: result.status,
          recipients: result.recipients,
          skipped: result.skipped,
          reason: result.reason,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    },
  };
}

export function runReportEmails(admin: AdminClient, now = new Date()): Promise<ReportRunTotals> {
  return runScheduledReports(dbReportPorts(admin), now);
}
