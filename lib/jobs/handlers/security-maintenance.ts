import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/security_maintenance (pg_cron daily, 03:20 UTC): retention for the Phase 15 security tables.
 *   - raw IP addresses on auth_events are nulled after 30 days (the keyed hash stays)
 *   - auth_events older than 400 days, record_access_log older than each org's retention setting
 *     (default 365 days, never below 30), sessions unseen for 90 days and API read aggregates older than
 *     90 days are deleted
 * The work is one SQL function (public.security_maintenance), so it is a single transaction and is
 * covered by the database tests. Runs land in job_runs / System health like every other task.
 */
registerTask("security_maintenance", {
  name: "security.maintenance",
  async run(admin, log) {
    const { data, error } = await admin.rpc("security_maintenance");
    if (error) throw new Error(`security_maintenance failed (${error.code ?? "unknown"})`);
    log.info("security maintenance done", (data ?? {}) as Record<string, number>);
    return data ?? {};
  },
});
