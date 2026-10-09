import { cronMatches } from "@/lib/cron";
import { runProgramme } from "@/lib/recall/engine";
import { createRecallDeps } from "@/lib/recall/supabase-deps";
import { syncSendStatuses } from "@/lib/recall/sync";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/recall_run (pg_cron every minute): runs every ACTIVE recall programme whose cron expression
 * matches this minute (Asia/Dubai), then mirrors delivery status onto recall_sends. `last_run_at` is claimed
 * atomically, so overlapping pings never double-run a programme. recall_sends' unique key is the second guard.
 */
registerTask("recall_run", {
  name: "recall.run",
  async run(admin, log) {
    const now = new Date();
    const { data: programmes } = await admin.from("recall_programmes").select("id, key, cron_expression").eq("status", "active");
    const deps = createRecallDeps(admin);
    const results: Array<Record<string, unknown>> = [];
    for (const p of programmes ?? []) {
      if (!p.cron_expression || !cronMatches(p.cron_expression, now, deps.timezone)) continue;
      const cutoff = new Date(now.getTime() - 55_000).toISOString();
      const { data: claimed } = await admin
        .from("recall_programmes")
        .update({ last_run_at: now.toISOString() })
        .eq("id", p.id)
        .or(`last_run_at.is.null,last_run_at.lt.${cutoff}`)
        .select("id");
      if (!claimed?.length) continue;
      try {
        const summary = await runProgramme(deps, p.id);
        log.info("recall.run", { ...summary });
        results.push({ ...summary });
      } catch (err) {
        log.error("recall.run failed", { programme: p.key, error: err instanceof Error ? err.message : String(err) });
        results.push({ programme: p.key, error: "failed" });
      }
    }
    const synced = await syncSendStatuses(admin);
    return { ran: results.length, synced, results } as never;
  },
});
