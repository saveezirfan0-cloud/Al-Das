import { z } from "zod";

import { runCaptureForOrg } from "@/lib/finance/db";
import { runMaintenanceForOrg } from "@/lib/finance/maintenance-db";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `finance_capture` queue. The hourly tick (public.fin_capture_enqueue_ticks)
 * enqueues one { kind: 'tick', org_id } per org with capture enabled.
 *
 * This handler is the ONLY path to the Unite Finance API (CLAUDE.md rule 7).
 * runCapture itself refuses to do anything unless fin_capture_settings.enabled
 * is true for the org and the capture lease is free.
 */
const tick = z.object({ kind: z.literal("tick"), org_id: z.string().uuid() });
const maintenance = z.object({ kind: z.literal("maintenance"), org_id: z.string().uuid() });
const job = z.discriminatedUnion("kind", [tick, maintenance]);

/** The jobs route allows 60 s; leave headroom for the final insert and lease release. */
export const CAPTURE_BUDGET_MS = 45_000;

registerHandler({
  queue: "finance_capture",
  name: "finance.capture",
  batchSize: 1,
  visibilityTimeout: 120,
  maxReads: 3,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid finance_capture job");
    if (parsed.data.kind === "maintenance") {
      // Never calls Unite: strips old raw PII, re-matches claims, purges stale staging.
      const m = await runMaintenanceForOrg(ctx.admin, parsed.data.org_id);
      ctx.log.info("finance maintenance", m);
      return;
    }
    const result = await runCaptureForOrg(ctx.admin, parsed.data.org_id, CAPTURE_BUDGET_MS);
    ctx.log.info("finance capture", {
      status: result.status,
      stop: result.stop,
      batches: result.batches,
      records: result.records,
    });
    if (
      result.stop === "process_failed" ||
      result.stop === "raw_insert_failed" ||
      result.stop === "lost_response" ||
      result.stop === "bad_response"
    ) {
      // The exception (E09) is already open; fail the run so System health shows it. Not retried as a new pull:
      // a retry happens only after the visibility timeout and re-checks everything, including the lease.
      throw new PermanentJobError(`finance capture stopped: ${result.stop}`);
    }
  },
});
