import { runQualityReports } from "@/lib/ai/insights/run";
import { registerTask } from "@/lib/jobs/tasks";

/** /api/jobs/ai_quality_weekly (pg_cron, Mondays 04:30 UTC): one reply-quality report per AI-using organisation for the last full week. */
registerTask("ai_quality_weekly", {
  name: "ai.quality_weekly",
  run: (admin, log) => runQualityReports(admin, log),
});
