/**
 * The run loop. One `flow_steps` job executes exactly one node:
 *
 *   advance(runId):  lock(conversation) → load run → write step row → execute node
 *                    → persist outcome on the step → apply it (next job / wait / end) → unlock
 *
 * Idempotency: the step row (unique on run_id+seq) is written BEFORE side effects and holds the
 * executor's outcome once it finished, so a redelivered job replays the outcome instead of
 * sending the message twice. A crash after the send but before the outcome is stored leaves the
 * step 'running' and the node runs again; its sends carry the step key (run id + seq), which is
 * unique on messages, so the second attempt gets the first message back instead of a copy.
 * Waits use `scheduled_jobs` through deps.jobs, never in-memory timers.
 */
import { checkAnswer, matchOption, MAX_ANSWER_CHARS } from "@/lib/flow-engine/answers";
import type { FlowDeps, RunRecord } from "@/lib/flow-engine/deps";
import { EXECUTORS } from "@/lib/flow-engine/executors";
import type { ExecCtx } from "@/lib/flow-engine/executors/common";
import { questionSchema } from "@/lib/flow-engine/executors/messaging";
import { findNode, nextEdge, triggerNode } from "@/lib/flow-engine/graph";
import {
  MAX_STEPS,
  type FlowGraph,
  type FlowNode,
  type Outcome,
  type RunContext,
  type WaitingFor,
  emptyContext,
  flowStepKey,
} from "@/lib/flow-engine/types";

export type AdvanceResult =
  | { status: "locked" }
  | { status: "skipped"; reason: string }
  | { status: "ok"; next: "enqueued" | "waiting" | "finished" };

const lockKey = (run: RunRecord) => run.conversation_id ?? run.id;

function trimError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 300);
}

async function loadGraph(deps: FlowDeps, run: RunRecord): Promise<FlowGraph | null> {
  return deps.store.getGraph(run.flow_id, run.flow_version);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartInput = {
  flowId: string;
  contactId: string | null;
  conversationId: string | null;
  enquiryId?: string | null;
  trigger?: Record<string, unknown>;
  /** Initial run variables (e.g. a WhatsApp Flow form's answers as `form`). */
  vars?: Record<string, unknown>;
  startedBy?: string | null;
};

export type StartResult =
  | { started: true; runId: string }
  | {
      started: false;
      reason: "flow_inactive" | "no_graph" | "live_run_exists" | "channel_not_supported";
    };

export async function startRun(deps: FlowDeps, input: StartInput): Promise<StartResult> {
  const flow = await deps.store.getFlow(input.flowId);
  if (!flow || flow.status !== "active" || !flow.published_graph)
    return { started: false, reason: "flow_inactive" };
  const trig = triggerNode(flow.published_graph);
  if (!trig) return { started: false, reason: "no_graph" };
  // Flow steps send WhatsApp messages: never start on a website chat, Instagram or Messenger conversation.
  if (input.conversationId) {
    const type = (await deps.store.getConversation(input.conversationId))?.channel_type;
    if (type && type !== "whatsapp") return { started: false, reason: "channel_not_supported" };
  }

  const run = await deps.store.createRun({
    org_id: flow.org_id,
    flow_id: flow.id,
    flow_version: flow.version,
    contact_id: input.contactId,
    conversation_id: input.conversationId,
    enquiry_id: input.enquiryId ?? null,
    current_node_id: trig.id,
    context: { ...emptyContext(input.trigger ?? {}), vars: { ...(input.vars ?? {}) } },
    started_by: input.startedBy ?? null,
  });
  if (!run) return { started: false, reason: "live_run_exists" };

  if (input.conversationId) {
    await deps.store.setConversationBot(input.conversationId, {
      bot_active: true,
      flow_run_id: run.id,
    });
  }
  await deps.jobs.enqueueStep(run.id);
  return { started: true, runId: run.id };
}

// ---------------------------------------------------------------------------
// Advance (one node)
// ---------------------------------------------------------------------------

function buildScope(
  run: RunRecord,
  contact: Awaited<ReturnType<FlowDeps["store"]["getContact"]>>,
  vars: Record<string, string>,
): ExecCtx["scope"] {
  return {
    contact: contact
      ? {
          first_name: contact.first_name,
          last_name: contact.last_name,
          full_name: contact.full_name,
          email: contact.email ?? "",
          gender: contact.gender ?? "",
          language: contact.language ?? "",
          label: contact.label ?? "",
          ...Object.fromEntries(Object.entries(contact.custom).map(([k, v]) => [`custom_${k}`, v])),
        }
      : {},
    vars: { ...vars, ...run.context.vars },
    steps: run.context.steps,
    trigger: run.context.trigger,
    ...(run.context.trigger.appointment ? { appointment: run.context.trigger.appointment } : {}),
  };
}

export async function advance(deps: FlowDeps, runId: string): Promise<AdvanceResult> {
  const first = await deps.store.getRun(runId);
  if (!first) return { status: "skipped", reason: "run_not_found" };
  const owner = deps.uuid();
  const key = lockKey(first);
  if (!(await deps.lock.claim(key, owner))) return { status: "locked" };
  try {
    return await advanceLocked(deps, runId);
  } finally {
    await deps.lock.release(key, owner);
  }
}

async function advanceLocked(deps: FlowDeps, runId: string): Promise<AdvanceResult> {
  // Re-read inside the lock: a takeover may have cancelled the run while we waited.
  const run = await deps.store.getRun(runId);
  if (!run) return { status: "skipped", reason: "run_not_found" };
  if (run.status !== "running") return { status: "skipped", reason: `run_${run.status}` };
  if (!run.current_node_id) return finishRun(deps, run, "failed", "Run has no current node");

  if (run.step_count >= MAX_STEPS) {
    return finishRun(deps, run, "failed", `Stopped after ${MAX_STEPS} steps (possible loop)`);
  }
  const graph = await loadGraph(deps, run);
  if (!graph) return finishRun(deps, run, "failed", "Flow version not found");
  const node = findNode(graph, run.current_node_id);
  if (!node) return finishRun(deps, run, "failed", `Node ${run.current_node_id} no longer exists`);

  const seq = run.step_count + 1;
  const { step, created } = await deps.store.insertStep({
    run_id: run.id,
    org_id: run.org_id,
    seq,
    node_id: node.id,
    node_type: node.type,
    input: null,
  });

  let outcome: Outcome;
  const replayed =
    !created && step.status !== "running"
      ? (step.output?.__outcome as Outcome | undefined)
      : undefined;
  if (replayed) {
    outcome = replayed; // a previous attempt already executed this node; do not send again
  } else {
    // A step left 'running' (crash between the send and the update below) runs again with the same key, so its
    // send returns the message it already queued (messages.flow_step_key) instead of queueing a copy.
    outcome = await execute(deps, run, node, flowStepKey(run.id, seq));
    const status = outcome.kind === "fail" ? "failed" : outcome.kind === "wait" ? "waiting" : "ok";
    await deps.store.updateStep(step.id, {
      status,
      output: {
        ...(outcome.output ?? {}),
        __outcome: outcome as unknown as Record<string, unknown>,
      },
      error: outcome.kind === "fail" ? outcome.error : null,
    });
  }
  return applyOutcome(deps, run, graph, node, seq, outcome);
}

async function execute(
  deps: FlowDeps,
  run: RunRecord,
  node: FlowNode,
  stepKey: string,
): Promise<Outcome> {
  const [contact, conversation, vars] = await Promise.all([
    run.contact_id ? deps.store.getContact(run.contact_id) : Promise.resolve(null),
    run.conversation_id ? deps.store.getConversation(run.conversation_id) : Promise.resolve(null),
    deps.store.getVariables(run.org_id),
  ]);
  const ctx: ExecCtx = {
    run,
    node,
    deps,
    contact,
    conversation,
    scope: buildScope(run, contact, vars),
    stepKey,
  };
  try {
    return await EXECUTORS[node.type](ctx);
  } catch (err) {
    return { kind: "fail", error: trimError(err) };
  }
}

async function applyOutcome(
  deps: FlowDeps,
  run: RunRecord,
  graph: FlowGraph,
  node: FlowNode,
  seq: number,
  outcome: Outcome,
): Promise<AdvanceResult> {
  // A takeover may have cancelled the run while the node executed; do not resurrect it.
  const current = await deps.store.getRun(run.id);
  if (!current || current.status !== "running")
    return { status: "skipped", reason: `run_${current?.status ?? "gone"}` };
  const context: RunContext = {
    ...run.context,
    vars: { ...run.context.vars, ...(outcome.kind === "next" ? (outcome.vars ?? {}) : {}) },
    steps: {
      ...run.context.steps,
      [node.id]:
        outcome.kind === "fail"
          ? { error: outcome.error, ...(outcome.output ?? {}) }
          : { response: outcome.output ?? {} },
    },
  };

  switch (outcome.kind) {
    case "end":
      await deps.store.updateRun(run.id, { step_count: seq, context });
      return finishRun(deps, { ...run, step_count: seq, context }, outcome.status);
    case "wait":
      await deps.store.updateRun(run.id, {
        status: "waiting",
        waiting_for: outcome.waiting,
        step_count: seq,
        context,
      });
      return { status: "ok", next: "waiting" };
    case "fail": {
      const edge = nextEdge(graph, node.id, "fallback");
      if (!edge) {
        await deps.store.updateRun(run.id, { step_count: seq, context });
        return finishRun(deps, { ...run, step_count: seq, context }, "failed", outcome.error);
      }
      return moveTo(deps, run, edge.target, seq, context);
    }
    case "next": {
      const edge = nextEdge(graph, node.id, outcome.handle ?? "default");
      if (!edge) {
        await deps.store.updateRun(run.id, { step_count: seq, context });
        return finishRun(deps, { ...run, step_count: seq, context }, "completed");
      }
      return moveTo(deps, run, edge.target, seq, context);
    }
  }
}

async function moveTo(
  deps: FlowDeps,
  run: RunRecord,
  target: string,
  seq: number,
  context: RunContext,
): Promise<AdvanceResult> {
  await deps.store.updateRun(run.id, {
    status: "running",
    waiting_for: null,
    current_node_id: target,
    step_count: seq,
    context,
  });
  await deps.jobs.enqueueStep(run.id);
  return { status: "ok", next: "enqueued" };
}

// ---------------------------------------------------------------------------
// Finish / cancel
// ---------------------------------------------------------------------------

export async function finishRun(
  deps: FlowDeps,
  run: RunRecord,
  status: "completed" | "failed" | "cancelled",
  error?: string,
): Promise<AdvanceResult> {
  await deps.store.updateRun(run.id, {
    status,
    waiting_for: null,
    error: error ?? null,
    ended_at: deps.now().toISOString(),
  });
  if (run.conversation_id && !run.parent_run_id) {
    await deps.store.setConversationBot(run.conversation_id, {
      bot_active: false,
      flow_run_id: null,
    });
  }
  if (run.parent_run_id) {
    await resumeParent(deps, run.parent_run_id, run.id, status);
  }
  return { status: "ok", next: "finished" };
}

async function resumeParent(
  deps: FlowDeps,
  parentId: string,
  childId: string,
  childStatus: string,
): Promise<void> {
  const parent = await deps.store.getRun(parentId);
  if (!parent || parent.status !== "waiting" || parent.waiting_for?.kind !== "child") return;
  if (parent.waiting_for.child_run_id !== childId) return;
  const graph = await loadGraph(deps, parent);
  if (!graph) return;
  const nodeId = parent.waiting_for.node_id;
  await deps.store.finishWaitingStep(parent.id, nodeId, { child_status: childStatus });
  const handle = childStatus === "completed" ? "default" : "fallback";
  await continueFrom(deps, parent, graph, nodeId, handle);
}

/** Follow `handle` from `nodeId`; no edge means the run is done (or failed when the handle was fallback). */
async function continueFrom(
  deps: FlowDeps,
  run: RunRecord,
  graph: FlowGraph,
  nodeId: string,
  handle: string,
  patch?: { vars?: Record<string, unknown>; response?: Record<string, unknown> },
): Promise<void> {
  const context: RunContext = {
    ...run.context,
    vars: { ...run.context.vars, ...(patch?.vars ?? {}) },
    steps: {
      ...run.context.steps,
      [nodeId]: { response: patch?.response ?? run.context.steps[nodeId]?.response ?? {} },
    },
  };
  const edge = nextEdge(graph, nodeId, handle);
  if (!edge) {
    await deps.store.updateRun(run.id, { context });
    await finishRun(
      deps,
      { ...run, context, status: "running" },
      handle === "fallback" ? "failed" : "completed",
      handle === "fallback" ? "Step failed with no fallback path" : undefined,
    );
    return;
  }
  await deps.store.updateRun(run.id, {
    status: "running",
    waiting_for: null,
    current_node_id: edge.target,
    context,
  });
  await deps.jobs.enqueueStep(run.id);
}

export async function cancelRun(deps: FlowDeps, runId: string, reason: string): Promise<boolean> {
  const run = await deps.store.getRun(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting")) return false;
  const key = lockKey(run);
  const owner = deps.uuid();
  // Best effort: if a step is mid-flight we still flip the status; the step re-reads status before applying.
  const locked = await deps.lock.claim(key, owner);
  try {
    await finishRun(deps, run, "cancelled", reason);
    // Cancel nested runs too.
    if (run.waiting_for?.kind === "child")
      await cancelRun(deps, run.waiting_for.child_run_id, reason);
    return true;
  } finally {
    if (locked) await deps.lock.release(key, owner);
  }
}

/** Human takeover: stop whatever the bot is doing in this conversation. */
export async function cancelActiveRunForConversation(
  deps: FlowDeps,
  conversationId: string,
  reason: string,
): Promise<boolean> {
  const live = await deps.store.getLiveRunForConversation(conversationId);
  if (!live) {
    await deps.store.setConversationBot(conversationId, { bot_active: false, flow_run_id: null });
    return false;
  }
  return cancelRun(deps, live.id, reason);
}

// ---------------------------------------------------------------------------
// Resume (timer / reply)
// ---------------------------------------------------------------------------

export type ResumeResult = { resumed: boolean; reason?: string };

async function withLock<T>(
  deps: FlowDeps,
  run: RunRecord,
  fn: () => Promise<T>,
): Promise<T | "locked"> {
  const owner = deps.uuid();
  const key = lockKey(run);
  if (!(await deps.lock.claim(key, owner))) return "locked";
  try {
    return await fn();
  } finally {
    await deps.lock.release(key, owner);
  }
}

/** A Wait finished (default edge) or a Question timed out (fallback edge). Stale tokens are ignored. */
export async function resumeFromTimer(
  deps: FlowDeps,
  runId: string,
  token: string,
): Promise<ResumeResult> {
  const run = await deps.store.getRun(runId);
  if (!run || run.status !== "waiting" || !run.waiting_for)
    return { resumed: false, reason: "not_waiting" };
  const w = run.waiting_for;
  if (w.token !== token) return { resumed: false, reason: "stale_token" };
  const r = await withLock(deps, run, async () => {
    const fresh = await deps.store.getRun(runId);
    if (!fresh || fresh.status !== "waiting" || fresh.waiting_for?.token !== token)
      return { resumed: false, reason: "not_waiting" } as ResumeResult;
    const graph = await loadGraph(deps, fresh);
    if (!graph) return { resumed: false, reason: "no_graph" } as ResumeResult;
    const handle = w.kind === "timer" ? "default" : "fallback";
    await deps.store.finishWaitingStep(fresh.id, w.node_id, { resumed_by: "timer" });
    await continueFrom(
      deps,
      { ...fresh, context: withoutAsk(fresh.context, w.node_id) },
      graph,
      w.node_id,
      handle,
    );
    return { resumed: true } as ResumeResult;
  });
  return r === "locked" ? { resumed: false, reason: "locked" } : r;
}

export type InboundReply = {
  kind: "text" | "button" | "list";
  text: string;
  optionId?: string | null;
};

/** `invalid` marks a reply the question could not accept: reason "reask" (asked again), "fallback" or "no_valid_answer" (run ended). */
export type ReplyResult = ResumeResult & { invalid?: boolean };

function withoutAsk(context: RunContext, nodeId: string): RunContext {
  if (!context.asks || !(nodeId in context.asks)) return context;
  const asks = { ...context.asks };
  delete asks[nodeId];
  return { ...context, asks };
}

/**
 * Called for each inbound message of a conversation whose bot run waits on a reply.
 *
 * Choice questions match an option (tapped id, title, or its number); free-text questions check the answer type
 * (lib/flow-engine/answers.ts). An answer that does not fit is asked again up to the node's `reask_max` (each re-ask is one
 * more step on the same node, so it counts against the 200-step cap and is replay-safe like any send), then follows the
 * fallback output. With re-asks used up and no fallback output the run ends with a clear error and the conversation goes
 * back to people. With neither re-asks nor a fallback output it keeps waiting (the pre-20b behaviour).
 */
export async function resumeFromReply(
  deps: FlowDeps,
  runId: string,
  reply: InboundReply,
): Promise<ReplyResult> {
  const run = await deps.store.getRun(runId);
  if (!run || run.status !== "waiting" || run.waiting_for?.kind !== "reply")
    return { resumed: false, reason: "not_waiting" };
  const r = await withLock(deps, run, async (): Promise<ReplyResult> => {
    const fresh = await deps.store.getRun(runId);
    if (!fresh || fresh.status !== "waiting" || fresh.waiting_for?.kind !== "reply")
      return { resumed: false, reason: "not_waiting" };
    const w = fresh.waiting_for as Extract<WaitingFor, { kind: "reply" }>;
    const graph = await loadGraph(deps, fresh);
    if (!graph) return { resumed: false, reason: "no_graph" };
    const node = findNode(graph, w.node_id);
    const parsed = node?.type === "question" ? questionSchema.safeParse(node.data) : null;
    const cfg = parsed?.success ? parsed.data : null;

    let accepted: { value: string; optionId: string | null; handle: string } | null = null;
    if (w.options.length > 0) {
      const option = matchOption(w.options, reply);
      if (option)
        accepted = { value: option.title, optionId: option.id, handle: `option:${option.id}` };
    } else {
      const check = checkAnswer(
        { type: cfg?.answer_type ?? "text", min: cfg?.min, max: cfg?.max, pattern: cfg?.pattern },
        reply.text,
      );
      if (check.ok) accepted = { value: check.value, optionId: null, handle: "default" };
    }

    if (!accepted) {
      // A question with no re-ask and no fallback output keeps waiting, exactly as before Phase 20b (published flows
      // are unchanged); the timeout, if any, still applies.
      if (!(cfg?.reask_max ?? 0) && !nextEdge(graph, w.node_id, "fallback"))
        return { resumed: false, reason: "unmatched_reply" };
      const asked = fresh.context.asks?.[w.node_id] ?? 0;
      await deps.store.finishWaitingStep(fresh.id, w.node_id, {
        answer_kind: reply.kind,
        invalid_answer: true,
      });
      if (asked < (cfg?.reask_max ?? 0)) {
        await deps.store.updateRun(fresh.id, {
          status: "running",
          waiting_for: null,
          current_node_id: w.node_id,
          context: {
            ...fresh.context,
            asks: { ...(fresh.context.asks ?? {}), [w.node_id]: asked + 1 },
          },
        });
        await deps.jobs.enqueueStep(fresh.id);
        return { resumed: true, reason: "reask", invalid: true };
      }
      const context = withoutAsk(fresh.context, w.node_id);
      if (!nextEdge(graph, w.node_id, "fallback")) {
        await deps.store.updateRun(fresh.id, { context });
        await finishRun(
          deps,
          { ...fresh, context, status: "running" },
          "failed",
          "The patient's answer did not fit and the question has no 'No / other answer' output",
        );
        return { resumed: true, reason: "no_valid_answer", invalid: true };
      }
      await continueFrom(deps, { ...fresh, context }, graph, w.node_id, "fallback", {
        response: { text: reply.text.slice(0, MAX_ANSWER_CHARS), option_id: null, invalid: true },
      });
      return { resumed: true, reason: "fallback", invalid: true };
    }

    // Save to the contact first: if that fails the job retries and nothing has moved yet.
    if (cfg?.save_to && fresh.contact_id) {
      await deps.actions.updateContactField(fresh, cfg.save_to, accepted.value);
    }
    const vars = w.variable ? { [w.variable]: accepted.value } : undefined;
    await deps.store.finishWaitingStep(fresh.id, w.node_id, {
      answer_kind: reply.kind,
      option_id: accepted.optionId,
    });
    await continueFrom(
      deps,
      { ...fresh, context: withoutAsk(fresh.context, w.node_id) },
      graph,
      w.node_id,
      accepted.handle,
      { vars, response: { text: accepted.value, option_id: accepted.optionId } },
    );
    return { resumed: true };
  });
  return r === "locked" ? { resumed: false, reason: "locked" } : r;
}
