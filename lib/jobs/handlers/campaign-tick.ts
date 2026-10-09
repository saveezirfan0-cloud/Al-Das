import { startCampaign } from "@/lib/campaigns/engine";
import { enqueue } from "@/lib/jobs/enqueue";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/campaign_tick (pg_cron every 30 s). Keeps campaigns moving:
 *  - one 'stats' op per live campaign (funnel, guardrails, completion, retry rounds),
 *    plus recently completed ones so late read receipts keep landing in the numbers
 *  - safety net for scheduled campaigns whose scheduled_jobs row never fired
 */
registerTask("campaign_tick", {
  name: "campaigns.tick",
  async run(admin, log) {
    const now = Date.now();
    const recent = new Date(now - 3 * 24 * 3600_000).toISOString();
    const stale = new Date(now - 5 * 60_000).toISOString();

    const { data: live } = await admin
      .from("campaigns")
      .select("id")
      .in("status", ["sending", "paused"])
      .limit(200);
    const { data: finished } = await admin
      .from("campaigns")
      .select("id")
      .eq("status", "completed")
      .gt("completed_at", recent)
      .or(`stats_refreshed_at.is.null,stats_refreshed_at.lt.${stale}`)
      .limit(100);

    const ids = [...(live ?? []), ...(finished ?? [])].map((c) => c.id);
    for (const id of ids) await enqueue("campaign_fanout", { op: "stats", campaign_id: id });

    const { data: overdue } = await admin
      .from("campaigns")
      .select("id")
      .eq("status", "scheduled")
      .lt("scheduled_at", new Date(now - 2 * 60_000).toISOString())
      .limit(50);
    // 'queued' means a start job was enqueued; one that is still waiting after a few minutes was lost.
    const { data: stuckQueued } = await admin
      .from("campaigns")
      .select("id")
      .eq("status", "queued")
      .lt("updated_at", new Date(now - 3 * 60_000).toISOString())
      .limit(50);
    let started = 0;
    for (const c of [...(overdue ?? []), ...(stuckQueued ?? [])])
      if (await startCampaign(admin, c.id)) started++;
    if (started) log.warn("started overdue scheduled campaigns", { started });

    // A request that died while building the audience leaves a 'preparing' campaign behind.
    const { data: abandoned } = await admin
      .from("campaigns")
      .update({ status: "failed", error: "Preparing the audience did not finish." })
      .eq("status", "preparing")
      .lt("created_at", new Date(now - 30 * 60_000).toISOString())
      .select("id");

    return {
      stats_ops: ids.length,
      started_overdue: started,
      abandoned: abandoned?.length ?? 0,
    };
  },
});
