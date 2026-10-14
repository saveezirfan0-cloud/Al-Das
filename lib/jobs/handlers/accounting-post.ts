import { runAccountingPosting } from "@/lib/accounting/posting/runner";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/accounting_post (pg_cron every 15 minutes): the Phase 22D posting engine, accounting.post. Posts the finance
 * sub-ledgers into the general ledger from each entity's ledger start, previews them before it, retries waiting items and
 * runs the automatic reversals. Never calls Unite; never writes a sub-ledger table. See lib/accounting/posting/runner.ts.
 */
registerTask("accounting_post", {
  name: "accounting.post",
  run: (admin, log) => runAccountingPosting(admin, log),
});
