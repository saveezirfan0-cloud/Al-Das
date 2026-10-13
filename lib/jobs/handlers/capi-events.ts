import { z } from "zod";

import { processCapiEvent } from "@/lib/integrations/capi/server";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `capi_events` queue: { event_row_id }. Server-side events for Meta's Conversions API (Phase 19b) have their own lane so retries and
 * back-off never slow WhatsApp sends. The switch, training mode, consent, attribution window and event age are checked again in
 * processCapiEvent when the event is actually sent.
 */
const job = z.object({ event_row_id: z.string().uuid() });

registerHandler({
  queue: "capi_events",
  name: "capi.send",
  batchSize: 25,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid capi job payload");
    const outcome = await processCapiEvent(ctx.admin, parsed.data.event_row_id, {
      readCt: ctx.readCt,
    });
    ctx.log.info("capi event processed", { outcome });
    if (outcome === "retry") throw new Error("meta conversions api unavailable; will retry");
  },
});
