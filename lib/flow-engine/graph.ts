/** Graph validation (run on Save for warnings, on Publish as a hard gate) and traversal helpers. */
import { INTENTS } from "@/lib/ai/intent/labels";
import { patternProblem } from "@/lib/flow-engine/node-options";
import {
  graphSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type NodeType,
} from "@/lib/flow-engine/types";

/** "structure": the graph itself is malformed. "setup": a node still needs its settings filled in or an output connected. Both block publishing when level is "error". */
export type GraphIssue = {
  level: "error" | "warning";
  nodeId?: string;
  message: string;
  kind?: "structure" | "setup";
};

/** Handles each node type may emit. `option:*` is validated separately for question nodes. */
const HANDLES: Partial<Record<NodeType, string[]>> = {
  trigger: ["default"],
  message: ["default", "fallback"],
  question: ["default", "fallback"],
  quick_reply: ["default", "fallback"],
  template: ["default", "fallback"],
  branch: ["true", "false", "fallback"],
  wait: ["default"],
  office_hours: ["inside", "outside"],
  run_flow: ["default", "fallback"],
  end_flow: [],
  assign_to: ["default", "fallback"],
  close_conversation: ["default"],
  add_comment: ["default", "fallback"],
  update_contact_field: ["default", "fallback"],
  create_enquiry: ["default", "fallback"],
  add_task: ["default", "fallback"],
  portal_record: ["default", "fallback"],
  book_appointment: ["default", "fallback"],
  api_action: ["default", "fallback"],
  send_notification: ["default", "fallback"],
  update_enquiry: ["default", "fallback"],
  set_label: ["default", "fallback"],
  payment_link: ["default", "fallback"],
  meta_event: ["default", "fallback"],
  ai_router: ["else"],
};

export function validateGraph(raw: unknown): { graph: FlowGraph | null; issues: GraphIssue[] } {
  const parsed = graphSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      graph: null,
      issues: parsed.error.issues.map((i) => ({
        level: "error" as const,
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const graph = parsed.data;
  const issues: GraphIssue[] = [];
  const byId = new Map<string, FlowNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id))
      issues.push({
        level: "error",
        nodeId: n.id,
        message: `Duplicate node id ${n.id}`,
        kind: "structure",
      });
    byId.set(n.id, n);
  }

  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) {
    issues.push({
      level: "error",
      message:
        triggers.length === 0
          ? "A flow needs exactly one trigger node"
          : "Only one trigger node is allowed",
    });
  }

  const seenHandles = new Set<string>();
  for (const e of graph.edges) {
    const src = byId.get(e.source);
    if (!src) {
      issues.push({ level: "error", message: `Edge ${e.id} starts at a missing node` });
      continue;
    }
    if (!byId.has(e.target)) {
      issues.push({ level: "error", message: `Edge ${e.id} points to a missing node` });
      continue;
    }
    if (byId.get(e.target)!.type === "trigger") {
      issues.push({
        level: "error",
        nodeId: e.target,
        message: "Nothing can connect into the trigger",
      });
    }
    const handle = e.sourceHandle ?? "default";
    const allowed = HANDLES[src.type] ?? [];
    const okOption =
      (src.type === "question" && handle.startsWith("option:")) ||
      (src.type === "ai_router" && handle.startsWith("intent:"));
    if (!allowed.includes(handle) && !okOption) {
      issues.push({
        level: "error",
        nodeId: src.id,
        message: `${src.type} has no "${handle}" output`,
      });
    }
    const dup = `${e.source}:${handle}`;
    if (seenHandles.has(dup))
      issues.push({
        level: "error",
        nodeId: src.id,
        message: `Output "${handle}" is connected twice`,
      });
    seenHandles.add(dup);
  }

  // Reachability from the trigger.
  if (triggers.length === 1) {
    const reach = new Set<string>([triggers[0]!.id]);
    const queue = [triggers[0]!.id];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const e of graph.edges) {
        if (e.source === cur && !reach.has(e.target)) {
          reach.add(e.target);
          queue.push(e.target);
        }
      }
    }
    for (const n of graph.nodes) {
      if (!reach.has(n.id))
        issues.push({ level: "warning", nodeId: n.id, message: "Not connected to the trigger" });
    }
    if (graph.nodes.length > 1 && graph.edges.every((e) => e.source !== triggers[0]!.id)) {
      issues.push({
        level: "error",
        nodeId: triggers[0]!.id,
        message: "The trigger is not connected to anything",
      });
    }
  }

  // Questions: ≤3 buttons or ≤10 list rows, unique option ids, every option should have an outgoing edge.
  for (const n of graph.nodes.filter((x) => x.type === "question")) {
    const opts = (n.data.options as Array<{ id: string; title: string }> | undefined) ?? [];
    const style = (n.data.style as string | undefined) ?? (opts.length > 0 ? "buttons" : "text");
    if (style === "buttons" && opts.length > 3)
      issues.push({ level: "error", nodeId: n.id, message: "Buttons are limited to 3 options" });
    if (style === "list" && opts.length > 10)
      issues.push({ level: "error", nodeId: n.id, message: "Lists are limited to 10 rows" });
    if (new Set(opts.map((o) => o.id)).size !== opts.length)
      issues.push({ level: "error", nodeId: n.id, message: "Option ids must be unique" });
    // Every option needs somewhere to go: an answer with no output would quietly end the run.
    for (const o of opts) {
      if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === `option:${o.id}`)) {
        issues.push({
          level: "error",
          nodeId: n.id,
          message: `Option "${o.title}" is not connected`,
          kind: "setup",
        });
      }
    }
    for (const e of graph.edges.filter((x) => x.source === n.id)) {
      const h = e.sourceHandle ?? "default";
      if (h.startsWith("option:") && !opts.some((o) => `option:${o.id}` === h))
        issues.push({
          level: "error",
          nodeId: n.id,
          message: `An output points at an option that no longer exists`,
          kind: "structure",
        });
    }
    if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === "fallback")) {
      issues.push({
        level: "warning",
        nodeId: n.id,
        message:
          "Connect 'No / other answer': without it the flow stops when an answer does not fit or nobody replies",
      });
    }
  }

  // AI router: one output per label, each label once, every label connected, plus Else.
  for (const n of graph.nodes.filter((x) => x.type === "ai_router")) {
    const intents = Array.isArray(n.data.intents) ? (n.data.intents as unknown[]) : [];
    for (const i of intents) {
      if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === `intent:${String(i)}`))
        issues.push({
          level: "error",
          nodeId: n.id,
          message: `Route "${String(i)}" is not connected`,
          kind: "setup",
        });
    }
    for (const e of graph.edges.filter((x) => x.source === n.id)) {
      const h = e.sourceHandle ?? "default";
      if (h.startsWith("intent:") && !intents.includes(h.slice("intent:".length)))
        issues.push({
          level: "error",
          nodeId: n.id,
          message: `An output points at a label this router does not use`,
          kind: "structure",
        });
    }
    if (!graph.edges.some((e) => e.source === n.id && e.sourceHandle === "else"))
      issues.push({
        level: "error",
        nodeId: n.id,
        message: "Connect the Else output (it runs when AI is off or no label fits)",
        kind: "setup",
      });
  }

  for (const n of graph.nodes) issues.push(...setupIssues(n));

  return { graph, issues };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";
const isUuid = (v: unknown) => typeof v === "string" && UUID.test(v);

/** Required settings per node type. Missing ones would only fail at run time, so they block Publish instead. */
export function setupIssues(n: FlowNode): GraphIssue[] {
  const d = n.data;
  const need = (ok: boolean, message: string): GraphIssue[] =>
    ok ? [] : [{ level: "error", nodeId: n.id, message, kind: "setup" }];
  switch (n.type) {
    case "question": {
      const regex =
        d.style === "text" && d.answer_type === "regex"
          ? patternProblem(typeof d.pattern === "string" ? d.pattern : "")
          : null;
      return [
        ...need(nonEmpty(d.text), "Write the message text"),
        ...need(!regex, regex ?? ""),
        ...need(
          d.save_to !== "email" || (d.style === "text" && d.answer_type === "email"),
          "Only an e-mail answer can be saved to the e-mail field",
        ),
      ];
    }
    case "message":
    case "quick_reply":
      return need(nonEmpty(d.text), "Write the message text");
    case "add_comment":
      return need(nonEmpty(d.text), "Write the note");
    case "template":
      return need(
        typeof d.template_id === "string" && UUID.test(d.template_id),
        "Choose a template",
      );
    case "run_flow":
      return need(typeof d.flow_id === "string" && UUID.test(d.flow_id), "Choose the flow to run");
    case "assign_to": {
      const t = (d.target ?? {}) as { type?: string; id?: string };
      return need(
        t.type === "bot" || t.type === "unassign" || (typeof t.id === "string" && UUID.test(t.id)),
        "Choose who to assign to",
      );
    }
    case "wait":
      return need(typeof d.amount === "number" && d.amount > 0, "Set how long to wait");
    case "branch":
      return need(
        Array.isArray(d.conditions) && d.conditions.length > 0,
        "Add at least one condition",
      );
    case "update_contact_field":
      return need(nonEmpty(d.field), "Choose the field to update");
    case "api_action":
      return need(
        typeof d.url === "string" && /^https:\/\/\S+/.test(d.url.trim()),
        "Enter an https:// URL",
      );
    case "send_notification": {
      const t = (d.target ?? {}) as { id?: string };
      return [
        ...need(nonEmpty(d.title), "Write the notification title"),
        ...need(nonEmpty(t.id), "Choose who to notify"),
      ];
    }
    case "create_enquiry":
      return need(nonEmpty(d.title), "Write the enquiry title");
    case "update_enquiry": {
      const a = d.action;
      if (a === "stage") return need(isUuid(d.stage_id), "Choose the stage");
      if (a === "pipeline") return need(isUuid(d.pipeline_id), "Choose the pipeline");
      if (a === "status")
        return need(
          ["open", "won", "lost", "disqualified"].includes(String(d.status)),
          "Choose the status",
        );
      if (a === "field") return need(nonEmpty(d.field), "Choose the field");
      return need(false, "Choose what to change");
    }
    case "add_task":
      return need(nonEmpty(d.subject), "Write the task subject");
    case "portal_record":
      return [
        ...need(nonEmpty(d.object), "Choose the portal object"),
        ...need(d.mode !== "update" || nonEmpty(d.record_id), "Enter the record id to update"),
      ];
    case "book_appointment":
      return [
        ...need(
          isUuid(d.service_id) && isUuid(d.specialist_id) && isUuid(d.location_id),
          "Choose the service, specialist and location",
        ),
        ...need(nonEmpty(d.starts_at), "Set the appointment time (usually a variable)"),
      ];
    case "set_label":
      return need(isUuid(d.tag_id), "Choose the label");
    case "payment_link":
      return need(nonEmpty(d.invoice_number) && nonEmpty(d.amount), "Set the invoice and amount");
    case "meta_event":
      return need(
        ["Contact", "Lead", "Schedule"].includes(String(d.event_name)),
        "Choose the event",
      );
    case "ai_router": {
      const intents = Array.isArray(d.intents) ? d.intents : [];
      return [
        ...need(intents.length > 0, "Choose at least one label to route on"),
        ...need(
          intents.every(
            (i) =>
              typeof i === "string" &&
              i !== "emergency" &&
              (INTENTS as readonly string[]).includes(i),
          ),
          "A possible emergency is never routed: it always goes to a person",
        ),
        ...need(new Set(intents).size === intents.length, "Each label can only have one output"),
      ];
    }
    default:
      return [];
  }
}

export function hasErrors(issues: GraphIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export function findNode(graph: FlowGraph, id: string): FlowNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** The edge leaving `nodeId` through `handle` (null handle on an edge means "default"). */
export function nextEdge(graph: FlowGraph, nodeId: string, handle: string): FlowEdge | undefined {
  return graph.edges.find((e) => e.source === nodeId && (e.sourceHandle ?? "default") === handle);
}

export function triggerNode(graph: FlowGraph): FlowNode | undefined {
  return graph.nodes.find((n) => n.type === "trigger");
}
