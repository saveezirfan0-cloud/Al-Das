import { cronMatches } from "@/lib/cron";
import { startRun } from "@/lib/flow-engine/run";
import { createFlowDeps } from "@/lib/flow-engine/supabase-deps";
import { registerTask } from "@/lib/jobs/tasks";

const MAX_CONTACTS_PER_TICK = 200;

/**
 * /api/jobs/flow_recurring (pg_cron every minute): fires active "Recurring" flows whose cron
 * expression (trigger_config.cron, evaluated in trigger_config.timezone, default Asia/Dubai) matches
 * this minute. With trigger_config.segment_id the flow starts once per segment member (capped);
 * without it, one contact-less run. `flows.last_triggered_at` is claimed atomically so overlapping
 * pings never double-fire.
 */
registerTask("flow_recurring", {
  name: "flows.recurring",
  async run(admin, log) {
    const now = new Date();
    const { data: flows } = await admin
      .from("flows")
      .select("id, org_id, trigger_config")
      .eq("trigger_type", "recurring")
      .eq("status", "active");
    const deps = createFlowDeps(admin);
    let fired = 0;
    let runs = 0;
    for (const flow of flows ?? []) {
      const cfg = (flow.trigger_config ?? {}) as {
        cron?: string;
        timezone?: string;
        segment_id?: string;
      };
      if (!cfg.cron || !cronMatches(cfg.cron, now, cfg.timezone ?? "Asia/Dubai")) continue;

      const cutoff = new Date(now.getTime() - 55_000).toISOString();
      const { data: claimed } = await admin
        .from("flows")
        .update({ last_triggered_at: now.toISOString() })
        .eq("id", flow.id)
        .or(`last_triggered_at.is.null,last_triggered_at.lt.${cutoff}`)
        .select("id");
      if (!claimed?.length) continue;
      fired += 1;

      let contactIds: Array<string | null> = [null];
      if (cfg.segment_id) {
        const { data: members } = await admin
          .from("segment_members")
          .select("contact_id")
          .eq("segment_id", cfg.segment_id)
          .eq("org_id", flow.org_id)
          .limit(MAX_CONTACTS_PER_TICK);
        contactIds = (members ?? []).map((m) => m.contact_id);
      }
      for (const contactId of contactIds) {
        const r = await startRun(deps, {
          flowId: flow.id,
          contactId,
          conversationId: null,
          trigger: { event: "recurring", at: now.toISOString() },
        });
        if (r.started) runs += 1;
      }
      log.info("flow.recurring.fired", { flow_id: flow.id, contacts: contactIds.length });
    }
    return { fired, runs };
  },
});
