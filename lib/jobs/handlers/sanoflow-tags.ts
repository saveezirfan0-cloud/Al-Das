import { z } from "zod";

import { processSanoflowTagJob } from "@/lib/integrations/sanoflow/tagging";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `sanoflow_tags` queue: { org_id, contact_id, programme }. After a Live recall send through Sanoflow, writes Make's tag (and
 * the chronic label) to the Sanoflow contact (docs/49 D11). Its own lane, best effort: an outcome word is logged and the job
 * never retries, so a slow or failing Sanoflow contacts API cannot hold up or repeat anything.
 */
const job = z.object({
  org_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  programme: z.enum(["birthday", "chronic_90d"]),
});

registerHandler({
  queue: "sanoflow_tags",
  name: "sanoflow.tag_contact",
  batchSize: 10,
  visibilityTimeout: 60,
  maxReads: 1,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid sanoflow tag job payload");
    const outcome = await processSanoflowTagJob(ctx.admin, {
      orgId: parsed.data.org_id,
      contactId: parsed.data.contact_id,
      programme: parsed.data.programme,
    });
    ctx.log.info("sanoflow contact tagged", { outcome, programme: parsed.data.programme });
  },
});
