import { registerTask } from "@/lib/jobs/tasks";

const IDEMPOTENCY_TTL_MS = 48 * 3600_000;
const DELIVERY_LOG_TTL_MS = 30 * 24 * 3600_000;

/**
 * /api/jobs/metrics_refresh (pg_cron every 15 min):
 *   1. refresh the dashboard/report materialized views concurrently, in dependency order, so readers
 *      are never blocked. Going through the app (instead of cron calling refresh directly) puts every
 *      run in job_runs and System health.
 *   2. light housekeeping that rides the same schedule: drop API idempotency keys after 48 h and
 *      finished webhook deliveries (delivered or dead) after 30 days.
 */
registerTask("metrics_refresh", {
  name: "metrics.refresh",
  async run(admin, log) {
    const started = Date.now();
    const { data, error } = await admin.rpc("refresh_metrics");
    if (error) throw new Error(`refresh_metrics failed (${error.code ?? "unknown"})`);
    const refreshed = data ?? [];

    const now = Date.now();
    const [idem, deliveries] = await Promise.all([
      admin.from("api_idempotency").delete({ count: "exact" }).lt("created_at", new Date(now - IDEMPOTENCY_TTL_MS).toISOString()),
      admin
        .from("webhook_deliveries")
        .delete({ count: "exact" })
        .in("status", ["success", "dead"])
        .lt("created_at", new Date(now - DELIVERY_LOG_TTL_MS).toISOString()),
    ]);
    const pruned = { idempotency_keys: idem.count ?? 0, webhook_deliveries: deliveries.count ?? 0 };

    log.info("metrics refreshed", { views: refreshed.length, ms: Date.now() - started, ...pruned });
    return { refreshed, pruned };
  },
});
