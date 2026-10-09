import { z } from "zod";

import { evaluateBranch, BRANCH_OPS } from "@/lib/flow-engine/conditions";
import { fail, parseConfig, type Executor } from "@/lib/flow-engine/executors/common";
import { isWithinOfficeHours, officeHoursSchema } from "@/lib/flow-engine/office-hours";
import { MAX_FLOW_DEPTH } from "@/lib/flow-engine/types";

const branchSchema = z.object({
  logic: z.enum(["and", "or"]).default("and"),
  conditions: z
    .array(
      z.object({ left: z.string().min(1), op: z.enum(BRANCH_OPS), right: z.string().optional() }),
    )
    .max(20),
});

export const branch: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, branchSchema);
  if (!cfg.ok) return cfg.outcome;
  const result = evaluateBranch(cfg.data, ctx.scope);
  return { kind: "next", handle: result ? "true" : "false", output: { result } };
};

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
const MAX_WAIT_MS = 30 * 86_400_000;

const waitSchema = z.object({
  amount: z.number().positive(),
  unit: z.enum(["seconds", "minutes", "hours", "days"]),
});

export const wait: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, waitSchema);
  if (!cfg.ok) return cfg.outcome;
  const ms = cfg.data.amount * UNIT_MS[cfg.data.unit];
  if (ms > MAX_WAIT_MS) return fail("Waits are limited to 30 days");
  const resumeAt = new Date(ctx.deps.now().getTime() + ms);
  const token = ctx.deps.uuid();
  await ctx.deps.jobs.scheduleResume({
    orgId: ctx.run.org_id,
    runId: ctx.run.id,
    token,
    runAt: resumeAt,
  });
  return {
    kind: "wait",
    output: { resume_at: resumeAt.toISOString() },
    waiting: { kind: "timer", token, node_id: ctx.node.id, resume_at: resumeAt.toISOString() },
  };
};

export const office_hours: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, officeHoursSchema);
  if (!cfg.ok) return cfg.outcome;
  const inside = isWithinOfficeHours(cfg.data, ctx.deps.now());
  return { kind: "next", handle: inside ? "inside" : "outside", output: { inside } };
};

const runFlowSchema = z.object({ flow_id: z.string().uuid() });

export const run_flow: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, runFlowSchema);
  if (!cfg.ok) return cfg.outcome;
  const depth = (ctx.run.context.depth ?? 0) + 1;
  if (depth > MAX_FLOW_DEPTH)
    return fail(`Flows can be nested ${MAX_FLOW_DEPTH} levels deep at most`);
  if (cfg.data.flow_id === ctx.run.flow_id) return fail("A flow cannot run itself");
  const flow = await ctx.deps.store.getFlow(cfg.data.flow_id);
  if (!flow || flow.org_id !== ctx.run.org_id) return fail("Flow not found");
  if (flow.status !== "active" || !flow.published_graph) return fail("Flow is not published");
  const trigger = flow.published_graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) return fail("Flow has no trigger");
  const child = await ctx.deps.store.createRun({
    org_id: ctx.run.org_id,
    flow_id: flow.id,
    flow_version: flow.version,
    contact_id: ctx.run.contact_id,
    conversation_id: ctx.run.conversation_id,
    enquiry_id: ctx.run.enquiry_id,
    current_node_id: trigger.id,
    context: {
      vars: { ...ctx.run.context.vars },
      trigger: ctx.run.context.trigger,
      steps: {},
      depth,
    },
    parent_run_id: ctx.run.id,
  });
  if (!child) return fail("Could not start the nested flow");
  await ctx.deps.jobs.enqueueStep(child.id);
  return {
    kind: "wait",
    output: { child_run_id: child.id },
    waiting: {
      kind: "child",
      token: ctx.deps.uuid(),
      node_id: ctx.node.id,
      child_run_id: child.id,
    },
  };
};

export const end_flow: Executor = async () => ({ kind: "end", status: "completed" });

export const trigger: Executor = async () => ({ kind: "next" });
