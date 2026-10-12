import { serverEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs/enqueue";
import { registerTask } from "@/lib/jobs/tasks";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { digestDue, digestWindow, renderDigest, type DigestKind } from "@/lib/notify/digest";
import { memberIdsWithPermission } from "@/lib/notify/dispatch-db";
import { resolveDelivery, type PrefRow } from "@/lib/notify/preferences";
import { DEFAULT_FILTERS } from "@/lib/reports/filters";
import { loadManagementSummary, summarySections } from "@/lib/reports/management";
import { resolveRange } from "@/lib/reports/range";
import { availableSources } from "@/lib/reports/server";

/**
 * /api/jobs/notification_digests (pg_cron hourly, minute 5): the daily and weekly management digest e-mails.
 *
 * Each org is checked in its own timezone: a digest is due from 07:00 for four hours (weekly: Mondays).
 * People opt in under Settings > Notifications (`digest.daily` / `digest.weekly`, channel e-mail) and need
 * `reports.view`. The numbers come from loadManagementSummary(), the same function the Management dashboard
 * page uses, so the e-mail and the page agree. Idempotent: notification_digest_log has a unique row per
 * person, kind and org-local period, claimed before the e-mail is queued.
 */
registerTask("notification_digests", {
  name: "notification.digests",
  run: (admin, log) => runDigests(admin, log),
});

export type DigestTotals = {
  orgs: number;
  queued: number;
  skipped_already_sent: number;
  failed: number;
};

/** The task body, with the clock injectable so tests can pick the hour. */
export async function runDigests(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<DigestTotals> {
  {
    const totals: DigestTotals = { orgs: 0, queued: 0, skipped_already_sent: 0, failed: 0 };
    const { data: orgs } = await admin.from("orgs").select("id, name, timezone");
    const appUrl = serverEnv().APP_URL.replace(/\/$/, "");

    for (const org of orgs ?? []) {
      const tz = org.timezone || "UTC";
      const kinds = (["daily", "weekly"] as DigestKind[]).filter((k) => digestDue(k, now, tz));
      if (kinds.length === 0) continue;
      totals.orgs++;

      const allowed = new Set(await memberIdsWithPermission(admin, org.id, "reports.view"));
      let available: string[] | null = null;

      for (const kind of kinds) {
        const event = `digest.${kind}`;
        const { data: optedIn } = await admin
          .from("notification_preferences")
          .select("user_id")
          .eq("org_id", org.id)
          .eq("event", event)
          .eq("channel", "email")
          .eq("enabled", true);
        const userIds = [...new Set((optedIn ?? []).map((r) => r.user_id))].filter((id) =>
          allowed.has(id),
        );
        if (userIds.length === 0) continue;

        const [{ data: profiles }, { data: prefRows }] = await Promise.all([
          admin.from("profiles").select("id, email").in("id", userIds),
          admin
            .from("notification_preferences")
            .select("user_id, event, channel, enabled, quiet_start, quiet_end")
            .eq("org_id", org.id)
            .in("user_id", userIds),
        ]);
        const window = digestWindow(kind, now, tz);

        // One summary per org and kind, shared by every recipient.
        let rendered: ReturnType<typeof renderDigest> | null = null;
        const build = async () => {
          available ??= await availableSources(admin);
          const range = resolveRange(
            { period: "custom", from: window.fromDay, to: window.toDay },
            tz,
            now,
          );
          const summary = await loadManagementSummary(
            {
              admin,
              orgId: org.id,
              timezone: tz,
              filters: {
                ...DEFAULT_FILTERS,
                period: "custom",
                from: window.fromDay,
                to: window.toDay,
              },
              range,
            },
            available,
          );
          return renderDigest({
            orgName: org.name,
            window,
            sections: summarySections(summary),
            dashboardUrl: `${appUrl}/dashboard/management`,
          });
        };

        for (const userId of userIds) {
          const email = profiles?.find((p) => p.id === userId)?.email;
          if (!email) continue;
          const prefs: PrefRow[] = (prefRows ?? []).filter((r) => r.user_id === userId);
          if (!resolveDelivery({ event, prefs, now, timezone: tz }).deliver.email) continue;

          // Claim the period first: a retried tick finds the row and sends nothing.
          const { error: claimError } = await admin
            .from("notification_digest_log")
            .insert({ org_id: org.id, user_id: userId, kind, period_key: window.periodKey });
          if (claimError) {
            if (claimError.code === "23505") totals.skipped_already_sent++;
            else totals.failed++;
            continue;
          }
          try {
            rendered ??= await build();
            await enqueue("notifications", {
              type: "email",
              to: email,
              subject: rendered.subject,
              text: rendered.text,
              html: rendered.html,
            });
            totals.queued++;
          } catch (err) {
            // Release the claim so the next hourly tick (still inside the window) can try again.
            await admin
              .from("notification_digest_log")
              .delete()
              .eq("org_id", org.id)
              .eq("user_id", userId)
              .eq("kind", kind)
              .eq("period_key", window.periodKey);
            totals.failed++;
            log.warn("digest not queued", {
              kind,
              error: err instanceof Error ? err.name : "unknown",
            });
          }
        }
      }
    }
    log.info("notification digests done", totals);
    return totals;
  }
}
