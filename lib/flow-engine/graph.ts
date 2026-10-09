/**
 * Graph helpers and the publish-time validator. Saving a draft only needs the shape to parse;
 * publishing runs `validateGraph` and refuses on errors (warnings are advice).
 */
import { KNOWN_FILTERS, references, SCOPE_ROOTS } from "@/lib/flow-engine/interpolate";
import { isValidCron } from "@/lib/flow-engine/cron";
import {
  CONVERSATION_TRIGGERS,
  MAX_STEPS_PER_RUN,
  NODE_META,
  flowGraphSchema,
  handlesFor,
  nodeDataSchemas,
  type FlowGraph,
  type FlowNode,
  type NodeType,
  type TriggerConfig,
  type TriggerType,
} from "@/lib/flow-engine/types";

export type GraphIssue = { severity: "error" | "warning"; nodeId?: string; message: string };

/** Nodes that talk to the patient or act on the conversation. */
const NEEDS_CONVERSATION: ReadonlySet<NodeType> = new Set<NodeType>([
  "message",
  "question",
  "quick_reply",
  "template",
  "assign_to",
  "close_conversation",
  "add_comment",
]);

/** Nodes that wait for the patient (the run stays alive until a reply or a timeout). */
export const WAITING_NODES: ReadonlySet<NodeType> = new Set<NodeType>(["question", "quick_reply"]);

export function findTrigger(graph: FlowGraph): FlowNode | undefined {
  return graph.nodes.find((n) => n.type === "trigger");
}

export function nodeById(graph: FlowGraph, id: string): FlowNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** The node an edge from (nodeId, handle) leads to; `default` is used when a specific handle has no edge. */
export function nextNodeId(graph: FlowGraph, nodeId: string, handle: string): string | null {
  const edges = graph.edges.filter((e) => e.source === nodeId);
  const normalise = (h: string | null | undefined) => h || "default";
  const exact = edges.find((e) => normalise(e.sourceHandle) === handle);
  if (exact) return exact.target;
  return null;
}

function textFields(type: NodeType, data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  switch (type) {
    case "message":
    case "add_comment":
      push(data.text);
      break;
    case "question":
    case "quick_reply":
      push(data.text);
      break;
    case "template":
      Object.values((data.values as Record<string, unknown>) ?? {}).forEach(push);
      break;
    case "update_contact":
      ((data.fields as Array<{ value?: unknown }>) ?? []).forEach((f) => push(f?.value));
      break;
    case "api_action":
      push(data.url);
      push(data.body);
      break;
    case "send_notification":
      push(data.title);
      push(data.body);
      break;
    case "add_task":
      push(data.subject);
      push(data.notes);
      break;
    case "portal_record":
      push(data.recordId);
      Object.values((data.values as Record<string, unknown>) ?? {}).forEach(push);
      break;
    default:
      break;
  }
  return out;
}

export function validateGraph(
  input: unknown,
  ctx: { triggerType: TriggerType; triggerConfig?: TriggerConfig; knownVariables?: string[] },
): {
  issues: GraphIssue[];
  errors: number;
  warnings: number;
  ok: boolean;
  graph: FlowGraph | null;
} {
  const issues: GraphIssue[] = [];
  const err = (message: string, nodeId?: string) =>
    issues.push({ severity: "error", nodeId, message });
  const warn = (message: string, nodeId?: string) =>
    issues.push({ severity: "warning", nodeId, message });

  const parsed = flowGraphSchema.safeParse(input);
  if (!parsed.success) {
    err("The graph is malformed and cannot be read.");
    return { issues, errors: 1, warnings: 0, ok: false, graph: null };
  }
  const graph = parsed.data;

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) err(`Duplicate node id "${n.id}"`, n.id);
    ids.add(n.id);
  }

  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) err("The flow has no trigger node.");
  if (triggers.length > 1) err("A flow has exactly one trigger node.");

  if (ctx.triggerType === "recurring") {
    const cron = ctx.triggerConfig?.cron;
    if (!cron || !isValidCron(cron))
      err("A recurring flow needs a valid schedule (five cron fields).");
  }

  const vars = new Set(ctx.knownVariables ?? []);
  for (const n of graph.nodes) {
    const schema = nodeDataSchemas[n.type];
    const res = schema.safeParse(n.data);
    if (!res.success) {
      for (const i of res.error.issues)
        err(
          `${NODE_META[n.type].label}: ${i.path.join(".") ? i.path.join(".") + " – " : ""}${i.message}`,
          n.id,
        );
    } else if (n.type === "question") {
      vars.add((res.data as { variable: string }).variable);
    } else if (n.type === "api_action") {
      const v = (res.data as { saveAs?: string }).saveAs;
      if (v) vars.add(v);
    }

    if (!CONVERSATION_TRIGGERS.has(ctx.triggerType) && NEEDS_CONVERSATION.has(n.type)) {
      warn(
        `${NODE_META[n.type].label} needs a conversation; this trigger has none unless the patient already has an open one.`,
        n.id,
      );
    }
    if (n.type === "template" && ctx.triggerType !== "recurring") {
      // fine: templates work outside the 24 h window
    }
    for (const t of textFields(n.type, n.data)) {
      for (const r of references(t)) {
        const root = r.path.split(".")[0];
        if (!(SCOPE_ROOTS as readonly string[]).includes(root))
          warn(`"{${r.path}}" is not a known field.`, n.id);
        for (const f of r.filters)
          if (!KNOWN_FILTERS.has(f)) warn(`Unknown filter "${f}" in "{${r.path}}".`, n.id);
      }
    }
  }

  // Edges
  for (const e of graph.edges) {
    const from = graph.nodes.find((n) => n.id === e.source);
    const to = graph.nodes.find((n) => n.id === e.target);
    if (!from || !to) {
      err("An arrow points at a node that does not exist.", from?.id ?? to?.id);
      continue;
    }
    if (to.type === "trigger") err("Nothing can lead back into the trigger.", to.id);
    const handle = e.sourceHandle || "default";
    if (!handlesFor(from.type, from.data).includes(handle)) {
      err(`${NODE_META[from.type].label} has no "${handle}" exit.`, from.id);
    }
  }

  // At most one arrow per exit.
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const key = `${e.source}:${e.sourceHandle || "default"}`;
    if (seen.has(key))
      err(
        `An exit of ${NODE_META[nodeById(graph, e.source)?.type ?? "trigger"].label} has more than one arrow.`,
        e.source,
      );
    seen.add(key);
  }

  // Reachability from the trigger.
  const trigger = triggers[0];
  if (trigger) {
    const reach = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const e of graph.edges)
        if (e.source === cur && !reach.has(e.target)) (reach.add(e.target), queue.push(e.target));
    }
    for (const n of graph.nodes)
      if (!reach.has(n.id))
        warn(
          `${NODE_META[n.type].label} is not connected to the trigger and will never run.`,
          n.id,
        );
    if (!graph.edges.some((e) => e.source === trigger.id))
      err("Connect the trigger to the first step.", trigger.id);

    // Branch / office-hours / question exits that lead nowhere end the run: fine, but say so for branches.
    for (const n of graph.nodes) {
      if (!reach.has(n.id)) continue;
      if (n.type === "branch" || n.type === "office_hours") {
        for (const h of handlesFor(n.type)) {
          if (!graph.edges.some((e) => e.source === n.id && (e.sourceHandle || "default") === h))
            warn(
              `The "${h}" exit of ${NODE_META[n.type].label} goes nowhere, so the flow ends there.`,
              n.id,
            );
        }
      }
      if (n.type === "question" || n.type === "quick_reply") {
        if (
          !graph.edges.some(
            (e) => e.source === n.id && (e.sourceHandle || "default") === "fallback",
          )
        )
          warn(
            `${NODE_META[n.type].label} has no "fallback" exit; an unexpected reply or a timeout ends the flow.`,
            n.id,
          );
      }
    }

    // A loop without any wait can only stop at the step cap.
    if (hasWaitFreeCycle(graph))
      warn(
        `A loop in this flow contains no wait or question; it will stop after ${MAX_STEPS_PER_RUN} steps.`,
      );
  }

  // Variables used but never set.
  for (const n of graph.nodes) {
    for (const t of textFields(n.type, n.data)) {
      for (const r of references(t)) {
        if (!r.path.startsWith("vars.") || r.filters.includes("default")) continue;
        const key = r.path.split(".")[1];
        if (key && !vars.has(key))
          warn(
            `Variable "${key}" is never set (no question saves to it and it is not defined under Variables).`,
            n.id,
          );
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return { issues, errors, warnings: issues.length - errors, ok: errors === 0, graph };
}

function hasWaitFreeCycle(graph: FlowGraph): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = byId.get(e.source);
    if (!from || WAITING_NODES.has(from.type) || from.type === "wait") continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}
