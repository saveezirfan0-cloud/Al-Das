import { z } from "zod";

import { readCopilotSettings, tagMayStartFlows } from "@/lib/ai/copilot/settings";
import { readAiSettings } from "@/lib/ai/settings";
import { createFlowDeps } from "@/lib/flow-engine/supabase-deps";
import { advance, finishRun, resumeFromTimer } from "@/lib/flow-engine/run";
import { handleTriggerEvent } from "@/lib/flow-engine/triggers";
import { enqueue } from "@/lib/jobs/enqueue";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `flow_steps` queue. Message shapes:
 *   { type:'step', run_id }                         run exactly one node
 *   { type:'trigger', org_id, event, payload }      a domain event that may start / resume flows
 *   { kind:'flow.resume', payload:{run_id, token} } scheduler envelope for timers and timeouts
 */
const stepJob = z.object({ type: z.literal("step"), run_id: z.string().uuid() });
const triggerJob = z.object({
  type: z.literal("trigger"),
  org_id: z.string().uuid(),
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const resumeJob = z.object({
  kind: z.literal("flow.resume"),
  payload: z.object({ run_id: z.string().uuid(), token: z.string().min(1) }),
});
const jobSchema = z.union([stepJob, triggerJob, resumeJob]);

const MAX_READS = 5;

registerHandler({
  queue: "flow_steps",
  name: "flows.step",
  batchSize: 20,
  visibilityTimeout: 60,
  maxReads: MAX_READS,
  concurrency: "parallel",
  async handler(raw, ctx) {
    const parsed = jobSchema.safeParse(raw);
    if (!parsed.success)
      throw new PermanentJobError(`invalid flow job: ${parsed.error.issues[0]?.message}`);
    const job = parsed.data;
    const deps = createFlowDeps(ctx.admin);

    if ("type" in job && job.type === "trigger") {
      let payload = job.payload;
      if (job.event === "conversation.ai_tagged") {
        // Defence in depth: an AI tag starts a flow only while the clinical lead's sign-off is in force (OQ-61), whatever queued this.
        const { data: org } = await ctx.admin
          .from("orgs")
          .select("settings")
          .eq("id", job.org_id)
          .maybeSingle();
        const ai = readAiSettings(org?.settings);
        const copilot = readCopilotSettings(org?.settings);
        const tags = (Array.isArray(job.payload.tags) ? job.payload.tags : []).filter(
          (t): t is string => typeof t === "string" && tagMayStartFlows(ai, copilot, t),
        );
        if (tags.length === 0) {
          ctx.log.info("flow.trigger skipped", {
            event: job.event,
            reason: "ai tags not signed off",
          });
          return;
        }
        payload = { ...job.payload, tags };
      }
      const out = await handleTriggerEvent(deps, {
        orgId: job.org_id,
        name: job.event,
        payload,
      });
      ctx.log.info("flow.trigger", {
        event: job.event,
        started: out.started.length,
        resumed: out.resumed,
      });
      return;
    }

    if ("kind" in job) {
      const r = await resumeFromTimer(deps, job.payload.run_id, job.payload.token);
      // Another step holds the conversation: fail this delivery so the scheduler retries with back-off.
      if (!r.resumed && r.reason === "locked") throw new Error("conversation busy");
      return;
    }

    try {
      const r = await advance(deps, job.run_id);
      if (r.status === "locked")
        await enqueue("flow_steps", { type: "step", run_id: job.run_id }, { delaySeconds: 2 });
    } catch (err) {
      // Infrastructure errors retry (the step row makes the replay idempotent). On the last read, fail the run
      // so it does not sit in "running" forever.
      if (ctx.readCt >= MAX_READS) {
        const run = await deps.store.getRun(job.run_id);
        if (run && (run.status === "running" || run.status === "waiting")) {
          await finishRun(
            deps,
            run,
            "failed",
            `Step could not be completed: ${(err as Error).message}`.slice(0, 300),
          );
        }
        throw new PermanentJobError((err as Error).message);
      }
      throw err;
    }
  },
});
