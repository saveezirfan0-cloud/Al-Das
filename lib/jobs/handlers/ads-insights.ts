import { syncAdInsights } from "@/lib/integrations/meta-ads/server";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * Phase 20i (G13): the daily read of Meta ad insights (spend, impressions, clicks per ad and day), pinged by pg_cron
 * (`pulse:ads_insights_sync`). A no-op for every workspace whose Meta ads spend integration is off, and for training workspaces.
 */
registerTask("ads_insights_sync", {
  name: "ads.insights_sync",
  async run(admin, log) {
    const r = await syncAdInsights(admin);
    log.info("ads insights sync", r);
    return r;
  },
});
