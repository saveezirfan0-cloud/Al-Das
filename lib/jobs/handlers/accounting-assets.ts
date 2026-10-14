import { runAccountingAssetsJob } from "@/lib/accounting/assets/job";
import { registerTask } from "@/lib/jobs/tasks";

/** /api/jobs/accounting_assets (pg_cron daily 04:25 UTC). See lib/accounting/assets/job.ts. Prepares, never posts. */
registerTask("accounting_assets", {
  name: "accounting.assets",
  run: (admin, log) => runAccountingAssetsJob(admin, log),
});
