import { runFinanceWorkflows } from "@/lib/finance/workflows";
import { registerTask } from "@/lib/jobs/tasks";

/** /api/jobs/finance_workflows (pg_cron daily 03:50 UTC). See lib/finance/workflows.ts. Never calls Unite. */
registerTask("finance_workflows", {
  name: "finance.workflows",
  run: (admin, log) => runFinanceWorkflows(admin, log),
});
