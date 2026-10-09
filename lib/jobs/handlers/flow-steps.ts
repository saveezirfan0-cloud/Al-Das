import { z } from "zod";

import {
  dispatchEvent,
  enqueueStep,
  runRecurring,
  sweepStuckRuns,
  type FlowJob,
} from "@/lib/flow-engine/service";
import { failRunAfterRetries, processStep } from "@/lib/flow-engine/step";
import { registerHandler } from "@/lib/jobs/registry";
import { registerKind } from "@/lib/jobs/scheduler";
import { registerTask } from "@/lib/jobs/tasks";
import { PermanentJobError } from "@/lib/jobs/types";
import type { Json } from "@/lib/supabase/types";

// Timers: scheduled_jobs → flow_steps ({kind: 'flow.timeout' | 'flow.wake', payload: {run_id, token}}).
registerKind("flow.*", "flow_steps");

const replySchema = z.object({
  type: z.string(),
  text: z.string().nullable(),
  interactiveId: z.string().nullable(),
});
const stepSchema = z.object({
  type: z.literal("step"),
  run_id: z.string().uuid(),
  expect: z.number().int().min(0),
  token: z.number().int().optional(),
  retries: z.number().int().optional(),
  input: z.discriminatedUnion("type", [
    z.object({ type: z.literal("start") }),
    z.object({ type: z.literal("timeout") }),
    z.object({ type: z.literal("time") }),
    z.object({
      type: z.literal("reply"),
      reply: replySchema,
      message_id: z.string().uuid().optional(),
    }),
  ]),
});
const eventSchema = z.object({
  type: z.literal("event"),
  org_id: z.string().uuid(),
  name: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
});
const timerSchema = z.object({
  kind: z.enum(["flow.timeout", "flow.wake"]),
  org_id: z.string().uuid().nullish(),
  payload: z.object({ run_id: z.string().uuid(), token: z.number().int() }),
});

const MAX_LOCK_RETRIES = 10;
const FINAL_READ = 4; // maxReads below is 5; on the last delivery the run is failed instead of left hanging

registerHandler<Json>({
  queue: "flow_steps",
  name: "Flow steps",
  batchSize: 25,
  visibilityTimeout: 90,
  maxReads: 5,
  concurrency: "serial",
  handler: async (payload, ctx) => {
    const raw = payload as Record<string, unknown>;

    if (raw.type === "event") {
      const ev = eventSchema.safeParse(raw);
      if (!ev.success) throw new PermanentJobError("invalid flow event job");
      const r = await dispatchEvent(
        ctx.admin,
        ev.data as unknown as Extract<FlowJob, { type: "event" }>,
      );
      if (r.started || r.resumed)
        ctx.log.info("flows: event handled", {
          name: ev.data.name,
          started: r.started,
          resumed: r.resumed,
        });
      return;
    }

    let job: z.infer<typeof stepSchema>;
    if (typeof raw.kind === "string" && raw.kind.startsWith("flow.")) {
      const t = timerSchema.safeParse(raw);
      if (!t.success) throw new PermanentJobError("invalid flow timer job");
      const { data: run } = await ctx.admin
        .from("flow_runs")
        .select("step_count, status")
        .eq("id", t.data.payload.run_id)
        .maybeSingle();
      if (!run || run.status !== "waiting") return; // answered, cancelled or finished since the timer was set
      job = {
        type: "step",
        run_id: t.data.payload.run_id,
        expect: run.step_count,
        token: t.data.payload.token,
        input: { type: t.data.kind === "flow.timeout" ? "timeout" : "time" },
      };
    } else {
      const s = stepSchema.safeParse(raw);
      if (!s.success) throw new PermanentJobError("invalid flow step job");
      job = s.data;
    }

    try {
      const result = await processStep(ctx.admin, job, `msg:${ctx.msgId}`);
      if (result === "locked") {
        const retries = (job.retries ?? 0) + 1;
        if (retries > MAX_LOCK_RETRIES) throw new Error("flow lock held too long");
        await enqueueStep({ ...job, retries } as never, 2);
      }
    } catch (err) {
      if (err instanceof PermanentJobError) throw err;
      if (ctx.readCt >= FINAL_READ) {
        await failRunAfterRetries(ctx.admin, job.run_id, "The step kept failing and was stopped.");
        ctx.log.error("flows: step abandoned", { run: job.run_id });
        return;
      }
      throw err;
    }
  },
});

// pg_cron every minute: recurring triggers + recovery of runs whose next step was lost.
registerTask("flows_recurring", {
  name: "Flows: recurring triggers",
  run: async (admin, log) => {
    const recurring = await runRecurring(admin);
    const recovered = await sweepStuckRuns(admin);
    if (recovered) log.warn("flows: re-queued stuck runs", { recovered });
    return { ...recurring, recovered } as unknown as Json;
  },
});
