import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/metrics_refresh (pg_cron every 15 min): refresh the dashboard/report materialized views
 * concurrently, in dependency order, so readers are never blocked. Going through the app (instead of
 * calling refresh straight from cron) puts every run in job_runs and System health.
 */
registerTask("metrics_refresh", {
  name: "metrics.refresh",
  async run(admin, log) {
    const started = Date.now();
    const { data, error } = await admin.rpc("refresh_metrics");
    if (error) throw new Error(`refresh_metrics failed (${error.code ?? "unknown"})`);
    const refreshed = data ?? [];
    log.info("metrics refreshed", { views: refreshed.length, ms: Date.now() - started });
    return { refreshed };
  },
});
