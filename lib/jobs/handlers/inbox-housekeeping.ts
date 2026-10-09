import { emit } from "@/lib/events/emit";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { readInboxSettings } from "@/lib/inbox/settings";
import { enqueue } from "@/lib/jobs/enqueue";
import { registerTask } from "@/lib/jobs/tasks";
import { createNotification } from "@/lib/notifications";

/**
 * /api/jobs/inbox_housekeeping (pg_cron every 5 min): per org inbox settings,
 *   - auto-close conversations idle for N hours
 *   - remove conversation labels older than N hours
 *   - email + notify assignees about conversations unread for N minutes
 */
registerTask("inbox_housekeeping", {
  name: "inbox.housekeeping",
  async run(admin, log) {
    const { data: orgs } = await admin.from("orgs").select("id, name, settings");
    const totals = { closed: 0, labels_removed: 0, alerts: 0 };
    for (const org of orgs ?? []) {
      const s = readInboxSettings(org.settings);
      const now = Date.now();

      if (s.auto_close_hours) {
        const cutoff = new Date(now - s.auto_close_hours * 3600_000).toISOString();
        const { data: closed } = await admin
          .from("conversations")
          .update({
            status: "closed",
            closed_at: new Date().toISOString(),
            closed_by: null,
            summary: "Closed automatically after inactivity.",
          })
          .eq("org_id", org.id)
          .neq("status", "closed")
          .eq("bot_active", false)
          .lt("last_message_at", cutoff)
          .select("id");
        for (const c of closed ?? [])
          await emit(org.id, "conversation.closed", { conversation_id: c.id, auto: true });
        totals.closed += closed?.length ?? 0;
      }

      if (s.auto_remove_labels_hours) {
        const cutoff = new Date(now - s.auto_remove_labels_hours * 3600_000).toISOString();
        const { data: removed } = await admin
          .from("conversation_labels")
          .delete()
          .eq("org_id", org.id)
          .lt("added_at", cutoff)
          .select("conversation_id");
        totals.labels_removed += removed?.length ?? 0;
      }

      if (s.unread_alert_minutes) {
        const cutoff = new Date(now - s.unread_alert_minutes * 60_000).toISOString();
        const { data: stale } = await admin
          .from("conversations")
          .select(
            "id, assignee_user_id, unread_count, last_inbound_at, unread_alerted_at, contacts(first_name, last_name, wa_profile_name, phone_e164)",
          )
          .eq("org_id", org.id)
          .neq("status", "closed")
          .gt("unread_count", 0)
          .not("assignee_user_id", "is", null)
          .lt("last_inbound_at", cutoff)
          .limit(200);
        for (const c of stale ?? []) {
          if (c.unread_alerted_at && c.last_inbound_at && c.unread_alerted_at >= c.last_inbound_at)
            continue;
          if (!c.assignee_user_id) continue;
          const { data: profile } = await admin
            .from("profiles")
            .select("email, first_name")
            .eq("id", c.assignee_user_id)
            .maybeSingle();
          const who = c.contacts ? contactDisplayName(c.contacts) : "a patient";
          const title = `Unread conversation with ${who}`;
          const body = `${c.unread_count} unread message${c.unread_count === 1 ? "" : "s"} waiting for more than ${s.unread_alert_minutes} minutes.`;
          await createNotification(admin, {
            orgId: org.id,
            userId: c.assignee_user_id,
            type: "inbox.unread",
            title,
            body,
            payload: { conversation_id: c.id },
          });
          if (profile?.email) {
            await enqueue("notifications", {
              type: "email",
              to: profile.email,
              subject: `[${org.name}] ${title}`,
              text: `${body}\n\nOpen the inbox: ${process.env.APP_URL ?? ""}/inbox?c=${c.id}`,
            });
          }
          await admin
            .from("conversations")
            .update({ unread_alerted_at: new Date().toISOString() })
            .eq("id", c.id);
          totals.alerts++;
        }
      }
    }
    // Webhook rows stored but never queued (enqueue failed in the ingress route): re-queue them.
    const stuckCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: stuck } = await admin
      .from("webhook_events_in")
      .select("id")
      .is("processed_at", null)
      .eq("attempts", 0)
      .lt("received_at", stuckCutoff)
      .limit(100);
    let requeued = 0;
    for (const row of stuck ?? []) {
      await admin.from("webhook_events_in").update({ attempts: 1 }).eq("id", row.id);
      await enqueue("meta_events", { event_id: row.id });
      requeued++;
    }

    const result = { ...totals, webhooks_requeued: requeued };
    log.info("inbox housekeeping done", result);
    return result;
  },
});
