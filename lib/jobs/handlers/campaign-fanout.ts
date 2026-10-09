import { z } from "zod";

import { refreshCampaign, runFanout, runRetryRound, startCampaign } from "@/lib/campaigns/engine";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `campaign_fanout` queue. Two payload shapes:
 *   { op: 'fanout' | 'stats', campaign_id }                   pushed by the app and the tick
 *   { kind: 'campaign.start' | 'campaign.retry_round', payload: { campaign_id, round? } }
 *                                                             pushed by the scheduler from scheduled_jobs
 * 'start' also exists as an op for "send now". Every op is idempotent: it re-reads the
 * campaign and does nothing when the state already moved on.
 */
const uuid = z.string().uuid();
const job = z.union([
  z.object({ op: z.enum(["start", "fanout", "stats"]), campaign_id: uuid }),
  z.object({
    kind: z.enum(["campaign.start", "campaign.retry_round"]),
    payload: z.object({ campaign_id: uuid, round: z.number().int().min(1).max(3).optional() }),
  }),
]);

registerHandler({
  queue: "campaign_fanout",
  name: "campaigns.fanout",
  batchSize: 10,
  visibilityTimeout: 120,
  maxReads: 3,
  concurrency: "parallel",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid campaign_fanout payload");
    const { admin, log } = ctx;
    const p = parsed.data;

    if ("kind" in p) {
      if (p.kind === "campaign.start") {
        const started = await startCampaign(admin, p.payload.campaign_id);
        log.info("scheduled campaign start", { campaignId: p.payload.campaign_id, started });
      } else {
        if (!p.payload.round) throw new PermanentJobError("retry_round without a round");
        await runRetryRound(admin, p.payload.campaign_id, p.payload.round, log);
      }
      return;
    }

    switch (p.op) {
      case "start": {
        const started = await startCampaign(admin, p.campaign_id);
        log.info("campaign start", { campaignId: p.campaign_id, started });
        break;
      }
      case "fanout": {
        const r = await runFanout(admin, p.campaign_id, log);
        log.info("campaign fanout", { campaignId: p.campaign_id, ...r });
        break;
      }
      case "stats":
        await refreshCampaign(admin, p.campaign_id, log);
        break;
    }
  },
});
