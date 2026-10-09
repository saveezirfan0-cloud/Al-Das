import { needsSlaAlert } from "@/lib/enquiries/sla";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { registerTask } from "@/lib/jobs/tasks";
import { createNotification, notifyMembersWithPermission } from "@/lib/notifications";
import { needsDueNotice } from "@/lib/tasks/due";

/**
 * /api/jobs/enquiries_housekeeping (pg_cron every 5 min):
 *   - SLA: an Open enquiry that sat in one stage longer than the org's SLA alerts its assignee once
 *     per stage visit (enquiries.manage holders when nobody owns it).
 *   - Tasks: an open assigned task whose due time has passed notifies the assignee once.
 * Each alert is claimed with a conditional update first, so overlapping runs never double-notify.
 * Notifications carry the enquiry number and pipeline only, never patient details.
 */
const BATCH = 200;

registerTask("enquiries_housekeeping", {
  name: "enquiries.housekeeping",
  async run(admin, log) {
    const now = new Date();
    const totals = { sla_alerts: 0, task_notices: 0 };

    const { data: orgs } = await admin.from("orgs").select("id, settings");
    for (const org of orgs ?? []) {
      const settings = readEnquirySettings(org.settings);
      if (!settings.sla_hours || !settings.notifications.on_sla_breach) continue;
      const cutoff = new Date(now.getTime() - settings.sla_hours * 3_600_000).toISOString();
      const { data: stale } = await admin
        .from("enquiries")
        .select(
          "id, number, status, assignee_id, stage_entered_at, sla_alerted_at, pipelines(name)",
        )
        .eq("org_id", org.id)
        .eq("status", "open")
        .lt("stage_entered_at", cutoff)
        .limit(BATCH);
      for (const e of stale ?? []) {
        if (!needsSlaAlert(e, settings.sla_hours, now)) continue;
        // Claim: only the run that flips sla_alerted_at from its previous value sends the alert.
        let claim = admin
          .from("enquiries")
          .update({ sla_alerted_at: now.toISOString() })
          .eq("id", e.id)
          .eq("stage_entered_at", e.stage_entered_at);
        claim = e.sla_alerted_at
          ? claim.eq("sla_alerted_at", e.sla_alerted_at)
          : claim.is("sla_alerted_at", null);
        const { data: claimed } = await claim.select("id");
        if (!claimed?.length) continue;
        const note = {
          type: "enquiry.sla_breached",
          title: `Enquiry #${e.number} passed its ${settings.sla_hours} h SLA`,
          body: e.pipelines?.name ?? "",
          payload: { enquiry_id: e.id },
        };
        if (e.assignee_id)
          await createNotification(admin, { orgId: org.id, userId: e.assignee_id, ...note });
        else await notifyMembersWithPermission(admin, org.id, "enquiries.manage", note);
        totals.sla_alerts++;
      }
    }

    const { data: due } = await admin
      .from("tasks")
      .select("id, org_id, subject, due_at, assignee_id, done, due_notified_at")
      .eq("done", false)
      .is("due_notified_at", null)
      .not("assignee_id", "is", null)
      .lte("due_at", now.toISOString())
      .limit(500);
    for (const t of due ?? []) {
      if (!needsDueNotice(t, now) || !t.assignee_id) continue;
      const { data: claimed } = await admin
        .from("tasks")
        .update({ due_notified_at: now.toISOString() })
        .eq("id", t.id)
        .is("due_notified_at", null)
        .select("id");
      if (!claimed?.length) continue;
      await createNotification(admin, {
        orgId: t.org_id,
        userId: t.assignee_id,
        type: "task.due",
        title: "A task is due",
        body: t.subject,
        payload: { task_id: t.id },
      });
      totals.task_notices++;
    }

    log.info("enquiries housekeeping done", totals);
    return totals;
  },
});
