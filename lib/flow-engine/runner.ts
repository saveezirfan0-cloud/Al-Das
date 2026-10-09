/**
 * The pure step function. One call = one node: execute it, decide what happens next, return the
 * trace row and the patches to the run. No I/O of its own (ports are injected), so the whole
 * walk through a flow is testable in memory.
 */
import {
  executeNode,
  type ExecEnv,
  type NodeResult,
  type StepInput,
} from "@/lib/flow-engine/executors";
import { findTrigger, nextNodeId, nodeById } from "@/lib/flow-engine/graph";
import { FlowNodeError, type FlowPorts } from "@/lib/flow-engine/ports";
import { MAX_STEPS_PER_RUN, type FlowGraph } from "@/lib/flow-engine/types";

export type WaitState = {
  type: "reply" | "time";
  node_id: string;
  token: number;
  expires_at: string | null;
};

export type RunState = {
  currentNodeId: string | null;
  stepCount: number;
  waitSeq: number;
  vars: Record<string, unknown>;
  steps: Record<string, unknown>;
  context: Record<string, string>;
};

export type StepTrace = {
  seq: number;
  nodeId: string;
  nodeType: string;
  status: "ok" | "waiting" | "failed";
  handle: string | null;
  detail: Record<string, unknown>;
  error: string | null;
};

export type StepNext =
  | { kind: "continue"; nodeId: string }
  | { kind: "wait"; wait: WaitState }
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "transfer"; flowId: string };

export type StepOutcome = {
  trace: StepTrace;
  next: StepNext;
  vars: Record<string, unknown>;
  steps: Record<string, unknown>;
  context: Record<string, string>;
};

/** Entry point for a new run: the node after the trigger (null = the flow does nothing). */
export function firstNodeId(graph: FlowGraph): string | null {
  const t = findTrigger(graph);
  return t ? nextNodeId(graph, t.id, "default") : null;
}

export async function runStep(
  graph: FlowGraph,
  state: RunState,
  input: StepInput,
  makeEnv: (nodeId: string, input: StepInput) => Pick<ExecEnv, "scope" | "ports">,
): Promise<StepOutcome> {
  const seq = state.stepCount + 1;
  const base = { vars: state.vars, steps: state.steps, context: state.context };
  const fail = (nodeId: string, nodeType: string, error: string): StepOutcome => ({
    ...base,
    trace: { seq, nodeId, nodeType, status: "failed", handle: null, detail: {}, error },
    next: { kind: "failed", error },
  });

  const node = state.currentNodeId ? nodeById(graph, state.currentNodeId) : undefined;
  if (!node)
    return fail(
      state.currentNodeId ?? "?",
      "unknown",
      "The step this run was on no longer exists.",
    );
  if (state.stepCount >= MAX_STEPS_PER_RUN)
    return fail(node.id, node.type, `Stopped after ${MAX_STEPS_PER_RUN} steps (the flow loops).`);

  let result: NodeResult;
  let ports: FlowPorts;
  try {
    const env = makeEnv(node.id, input);
    ports = env.ports;
    result = await executeNode(node, { nodeId: node.id, scope: env.scope, ports, input });
  } catch (e) {
    if (e instanceof FlowNodeError) return fail(node.id, node.type, e.message);
    throw e; // transient (database, network): let the job retry
  }

  const merged = {
    vars: { ...state.vars },
    steps: { ...state.steps },
    context: { ...state.context },
  };
  const trace = (
    status: StepTrace["status"],
    handle: string | null,
    detail: Record<string, unknown> | undefined,
    error: string | null = null,
  ): StepTrace => ({
    seq,
    nodeId: node.id,
    nodeType: node.type,
    status,
    handle,
    detail: detail ?? {},
    error,
  });

  switch (result.kind) {
    case "next": {
      Object.assign(merged.vars, result.vars ?? {});
      Object.assign(merged.context, result.context ?? {});
      if (result.output) merged.steps[node.id] = result.output;
      let target = nextNodeId(graph, node.id, result.handle);
      if (!target && result.handle.startsWith("option:"))
        target = nextNodeId(graph, node.id, "default");
      if (!target && result.failed) {
        return {
          ...merged,
          trace: trace("failed", result.handle, result.detail, result.failed),
          next: { kind: "failed", error: result.failed },
        };
      }
      return {
        ...merged,
        trace: trace("ok", result.handle, result.detail),
        next: target ? { kind: "continue", nodeId: target } : { kind: "completed" },
      };
    }
    case "wait_reply": {
      const expires = result.timeoutMinutes
        ? new Date(ports.now().getTime() + result.timeoutMinutes * 60_000).toISOString()
        : null;
      return {
        ...merged,
        trace: trace("waiting", null, result.detail),
        next: {
          kind: "wait",
          wait: { type: "reply", node_id: node.id, token: state.waitSeq + 1, expires_at: expires },
        },
      };
    }
    case "wait_time":
      return {
        ...merged,
        trace: trace("waiting", null, result.detail),
        next: {
          kind: "wait",
          wait: {
            type: "time",
            node_id: node.id,
            token: state.waitSeq + 1,
            expires_at: result.until.toISOString(),
          },
        },
      };
    case "end":
      return { ...merged, trace: trace("ok", null, result.detail), next: { kind: "completed" } };
    case "transfer":
      return {
        ...merged,
        trace: trace("ok", null, { to_flow: result.flowId }),
        next: { kind: "transfer", flowId: result.flowId },
      };
  }
}

export type { FlowPorts };
