"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import {
  nextEnabledAt,
  REPORT_EMAIL_PERMISSION,
  REPORT_EMAILS_MANAGE,
  scheduleInput,
} from "@/lib/finance/report-emails";
import { permissionMatches } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Report e-mail schedules (Phase G). finance.report_emails.manage; recipients are members of this organisation who hold
 * the report's own key now (the job checks again at every send). Written with the service role after the check and
 * audited with the kind, the switch, the time and the number of recipients (never their ids or addresses).
 */

async function gate() {
  const member = await requireMember();
  return can(member, REPORT_EMAILS_MANAGE) ? member : null;
}

export async function saveReportSchedule(raw: unknown): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = scheduleInput.safeParse(raw);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check

  // every recipient must be an active member here who holds the report's own key (window aside: that is per send)
  if (v.recipientIds.length > 0) {
    const { data: members, error } = await admin
      .from("memberships")
      .select("user_id, roles(permissions)")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .in("user_id", v.recipientIds);
    if (error) return fail("The members could not be checked. Try again.");
    const perm = REPORT_EMAIL_PERMISSION[v.kind];
    const allowed = new Set(
      (members ?? [])
        .filter((m) => {
          const perms = m.roles?.permissions;
          return (
            Array.isArray(perms) &&
            perms.some((p) => typeof p === "string" && permissionMatches(p, perm))
          );
        })
        .map((m) => m.user_id),
    );
    const refused = v.recipientIds.filter((id) => !allowed.has(id)).length;
    if (refused > 0)
      return fail(
        `${refused} of the people chosen cannot see this report (or are no longer members). Untick them and save again.`,
      );
  }

  const { data: before } = await admin
    .from("fin_report_schedules")
    .select("id, enabled, enabled_at")
    .eq("org_id", member.orgId)
    .eq("kind", v.kind)
    .maybeSingle();
  const enabledAt = nextEnabledAt(
    before ? { enabled: before.enabled, enabledAt: before.enabled_at } : null,
    v.enabled,
    new Date(),
  );
  const row = {
    enabled: v.enabled,
    send_time: v.sendTime,
    day_of_month: v.dayOfMonth,
    recipient_ids: v.recipientIds,
    enabled_at: enabledAt,
    updated_by: member.userId,
  };
  const { error } = before
    ? await admin
        .from("fin_report_schedules")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", before.id)
    : await admin
        .from("fin_report_schedules")
        .insert({ ...row, org_id: member.orgId, kind: v.kind, created_by: member.userId });
  if (error) return fail("The schedule could not be saved. Try again.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.report_email.schedule_saved",
    entity: "fin_report_schedules",
    entityId: before?.id ?? null,
    diff: {
      kind: v.kind,
      enabled: v.enabled,
      send_time: v.sendTime,
      day_of_month: v.dayOfMonth,
      recipients: v.recipientIds.length,
    },
  });
  revalidatePath("/finance/report-emails");
  return {
    ok: true,
    message: v.enabled
      ? "Saved. The report goes out at the next send time."
      : "Saved. This report is not e-mailed while it is switched off.",
  };
}
