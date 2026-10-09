/**
 * Flow graph model. The builder stores React Flow JSON; this file is the contract the
 * engine validates at publish time and again when a run starts.
 *
 * Edge handles (sourceHandle): default | fallback | option:<id> | inside | outside | true | false
 */
import { z } from "zod";

export const MAX_STEPS = 200;
export const MAX_FLOW_DEPTH = 3;

export const NODE_TYPES = [
  "trigger",
  // messaging
  "message",
  "question",
  "quick_reply",
  "template",
  // logic
  "branch",
  "wait",
  "office_hours",
  "run_flow",
  "end_flow",
  // conversation
  "assign_to",
  "close_conversation",
  "add_comment",
  // CRM
  "update_contact_field",
  "create_enquiry",
  "add_task",
  "portal_record",
  "book_appointment",
  // integrations
  "api_action",
  "send_notification",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TRIGGER_TYPES = [
  "conversation_opened",
  "conversation_closed",
  "conversation_waiting",
  "template_button",
  "shortcut",
  "enquiry_added",
  "enquiry_stage_updated",
  "enquiry_status_updated",
  "webhook",
  "recurring",
  "appointment_created",
  "appointment_updated",
  "appointment_status_changed",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const nodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type FlowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
});
export type FlowEdge = z.infer<typeof edgeSchema>;

export const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(300),
  edges: z.array(edgeSchema).max(600),
});
export type FlowGraph = z.infer<typeof graphSchema>;

/** Trigger conditions: Source / Keyword / Ad with equals, not equals, contains, not contains. */
export const CONDITION_CATEGORIES = ["source", "keyword", "ad"] as const;
export const CONDITION_OPS = ["equals", "not_equals", "contains", "not_contains"] as const;
export const triggerConditionSchema = z.object({
  category: z.enum(CONDITION_CATEGORIES),
  op: z.enum(CONDITION_OPS),
  value: z.string().max(200),
});
export type TriggerCondition = z.infer<typeof triggerConditionSchema>;

export const triggerConditionsSchema = z.object({
  logic: z.enum(["and", "or"]).default("and"),
  conditions: z.array(triggerConditionSchema).max(20).default([]),
});
export type TriggerConditions = z.infer<typeof triggerConditionsSchema>;

export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type StepStatus = "running" | "ok" | "waiting" | "skipped" | "failed";

/** Outcome an executor returns; the engine turns it into persistence + the next job. */
export type Outcome =
  | {
      kind: "next";
      /** Which outgoing edge to follow. Default: "default". */
      handle?: string;
      output?: Record<string, unknown>;
      /** Merged into run.context.vars */
      vars?: Record<string, unknown>;
    }
  | {
      kind: "wait";
      waiting: WaitingFor;
      output?: Record<string, unknown>;
    }
  | { kind: "end"; status: "completed" | "cancelled"; output?: Record<string, unknown> }
  /** Step failed. The engine follows a "fallback" edge if the node has one, else fails the run. */
  | { kind: "fail"; error: string; output?: Record<string, unknown> };

export type WaitingFor =
  | {
      kind: "timer";
      token: string;
      node_id: string;
      resume_at: string;
    }
  | {
      kind: "reply";
      token: string;
      node_id: string;
      /** Button / list options offered; empty = free text. */
      options: Array<{ id: string; title: string }>;
      variable?: string;
      timeout_at?: string;
    }
  | { kind: "child"; token: string; node_id: string; child_run_id: string };

export type RunContext = {
  vars: Record<string, unknown>;
  trigger: Record<string, unknown>;
  steps: Record<string, { response?: unknown; [k: string]: unknown }>;
  depth?: number;
};

export function emptyContext(trigger: Record<string, unknown> = {}, depth = 0): RunContext {
  return { vars: {}, trigger, steps: {}, depth };
}
