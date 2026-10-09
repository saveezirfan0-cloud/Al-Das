import { cronMatches } from "@/lib/flow-engine/cron";
import { orgTimezone } from "@/lib/flow-engine/scope";
import { registerTask } from "@/lib/jobs/tasks";
import { runProgramme, syncRecallSends } from "@/lib/recall/engine";

/**
 * /api/jobs/recall_programmes (pg_cron every minute): start every active programme whose schedule
 * matches this minute, then copy delivery status onto recall_sends. A programme run only ever
 * queues messages through the outbound queue (rate limit and 24 h window guard apply there).
 */
registerTask("recall_programmes", {
  name: "recall.programmes",
  async run(admin, log) {
    const now = new Date();
    const { data: programmes } = await admin
      .from("recall_programmes")
      .select("*")
      .eq("status", "active")
      .neq("eligibility", "managed")
      .not("cron_expression", "is", null);
    const tzs = new Map<string, string>();
    const totals = { due: 0, queued: 0, errors: 0 };
    for (const p of programmes ?? []) {
      if (!tzs.has(p.org_id)) tzs.set(p.org_id, await orgTimezone(admin, p.org_id));
      let due = false;
      try {
        due = cronMatches(p.cron_expression!, now, tzs.get(p.org_id));
      } catch {
        continue; // invalid schedules are rejected when saved; never let one stop the others
      }
      if (!due) continue;
      totals.due++;
      try {
        const r = await runProgramme(admin, p, { trigger: "schedule", now });
        totals.queued += r.queued;
      } catch (e) {
        totals.errors++;
        log.error("recall programme failed", {
          programme: p.key,
          message: e instanceof Error ? e.name : "unknown",
        });
      }
    }
    const synced = await syncRecallSends(admin);
    return { ...totals, synced };
  },
});
