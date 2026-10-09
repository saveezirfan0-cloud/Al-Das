import type { Edge, Node } from "@xyflow/react";

import { handlesFor, type FlowGraph, type FlowNode, type NodeType } from "@/lib/flow-engine/types";

/** Canvas node: the builder keeps the node type and its config under `data`. */
export type CanvasData = { nodeType: NodeType; config: Record<string, unknown> };
export type CanvasNode = Node<CanvasData, "flowNode">;
export type CanvasEdge = Edge;

export function toCanvas(graph: FlowGraph): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "flowNode" as const,
      position: n.position,
      data: { nodeType: n.type, config: n.data },
      deletable: n.type !== "trigger",
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || "default",
      type: "smoothstep",
    })),
  };
}

export function fromCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data.config,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle === "default" ? null : (e.sourceHandle ?? null),
    })),
  };
}

/** Drops arrows whose exit no longer exists (an option was removed, a node type changed). */
export function pruneEdges(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasEdge[] {
  const exits = new Map(
    nodes.map((n) => [n.id, new Set(handlesFor(n.data.nodeType, n.data.config))]),
  );
  return edges.filter(
    (e) => exits.get(e.source)?.has(e.sourceHandle || "default") && exits.has(e.target),
  );
}

export function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "message":
    case "add_comment":
      return { text: "" };
    case "question":
      return {
        text: "",
        kind: "buttons",
        options: [
          { id: "yes", title: "Yes" },
          { id: "no", title: "No" },
        ],
        variable: "answer",
      };
    case "quick_reply":
      return {
        text: "",
        options: [
          { id: "yes", title: "Yes" },
          { id: "no", title: "No" },
        ],
      };
    case "template":
      return { templateId: "", values: {} };
    case "branch":
      return { conditions: { include: { type: "group", logic: "and", children: [] } } };
    case "wait":
      return { amount: 5, unit: "minutes" };
    case "office_hours": {
      const day = [{ from: "09:00", to: "18:00" }];
      return { days: { mon: day, tue: day, wed: day, thu: day, fri: day } };
    }
    case "run_flow":
      return { flowId: "" };
    case "update_contact":
      return { fields: [{ field: "language", value: "" }] };
    case "enquiry":
      return { action: "create" };
    case "add_task":
      return { subject: "", dueInHours: 24 };
    case "portal_record":
      return { objectKey: "", action: "create", values: {} };
    case "appointment":
      return { action: "set_status" };
    case "api_action":
      return { method: "POST", url: "", headers: {} };
    case "send_notification":
      return { title: "" };
    default:
      return {};
  }
}

export function newNodeId(type: NodeType, existing: CanvasNode[]): string {
  const taken = new Set(existing.map((n) => n.id));
  let i = existing.filter((n) => n.data.nodeType === type).length + 1;
  while (taken.has(`${type}_${i}`)) i++;
  return `${type}_${i}`;
}

export type { FlowNode };
