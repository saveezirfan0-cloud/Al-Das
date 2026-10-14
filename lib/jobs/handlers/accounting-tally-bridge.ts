import { runTallyBridge } from "@/lib/accounting/tally/bridge-server";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/accounting_tally_bridge (pg_cron every 15 minutes): the Phase 22J Tally bridge. Queues the pulls from Tally,
 * finishes a pull that ran out of time and, before the ledger start, turns what changed in Pulse into Tally vouchers for
 * the connector to send. Never calls Tally itself (the connector on the Tally PC does). See
 * lib/accounting/tally/bridge-server.ts.
 */
registerTask("accounting_tally_bridge", {
  name: "accounting.tally_bridge",
  run: async (admin, log) => runTallyBridge(admin, log),
});
