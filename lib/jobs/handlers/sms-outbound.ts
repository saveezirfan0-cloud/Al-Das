import { z } from "zod";

import { processSmsJob } from "@/lib/integrations/sms/send";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `sms_outbound` queue: { sms_id }. The SMS fallback's own lane (Phase 19): nothing is sent inline from a request or from the
 * reminder job. The per-sender rate limit, daily limit, training-mode block and every consent rule are applied in
 * processSmsJob when the message is actually sent.
 */
const job = z.object({ sms_id: z.string().uuid() });

registerHandler({
  queue: "sms_outbound",
  name: "sms.send",
  batchSize: 25,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid sms job payload");
    const outcome = await processSmsJob(ctx.admin, parsed.data.sms_id, { readCt: ctx.readCt });
    ctx.log.info("sms job processed", { smsId: parsed.data.sms_id, outcome });
    if (outcome === "retry") throw new Error("sms provider unavailable; will retry");
  },
});
