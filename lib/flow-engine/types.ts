/**
 * Flow graph model (React Flow JSON) and per-node configuration, validated with Zod.
 * Framework-free: shared by the builder UI, the validator, the runner and the tests.
 *
 * Edges carry handles: `default`, `fallback`, `option:<id>`, `inside`/`outside`, `true`/`false`.
 */
import { z } from "zod";

import { filterSchema, type Filter } from "@/lib/filters/ast";

export const MAX_STEPS_PER_RUN = 200;
export const MAX_RUN_DEPTH = 5;
export const MAX_WAIT_DAYS = 30;
export const MAX_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const BUTTON_TITLE_MAX = 20;
export const ROW_TITLE_MAX = 24;
export const MESSAGE_TEXT_MAX = 4096;

export const TRIGGER_TYPES = [
  "conversation_opened",
  "conversation_closed",
  "conversation_waiting",
  "template_button_reply",
  "shortcut",
  "enquiry_added",
  "enquiry_stage_updated",
  "enquiry_status_updated",
  "incoming_webhook",
  "recurring",
  "appointment_created",
  "appointment_updated",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Domain event that fires each trigger type (the others start from a button, a URL or the clock). */
export const TRIGGER_EVENT: Partial<Record<TriggerType, string>> = {
  conversation_opened: "conversation.opened",
  conversation_closed: "conversation.closed",
  conversation_waiting: "conversation.waiting",
  template_button_reply: "message.received",
  enquiry_added: "enquiry.created",
  enquiry_stage_updated: "enquiry.stage_changed",
  enquiry_status_updated: "enquiry.status_changed",
  appointment_created: "appointment.created",
  appointment_updated: "appointment.updated",
};

/** Trigger types that need a conversation to run (they message the patient). */
export const CONVERSATION_TRIGGERS: ReadonlySet<TriggerType> = new Set<TriggerType>([
  "conversation_opened",
  "conversation_closed",
  "conversation_waiting",
  "template_button_reply",
  "shortcut",
]);

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  conversation_opened: "Conversation opened",
  conversation_closed: "Conversation closed",
  conversation_waiting: "Conversation waiting",
  template_button_reply: "Template button reply",
  shortcut: "Shortcut (from the inbox)",
  enquiry_added: "Enquiry added",
  enquiry_stage_updated: "Enquiry stage updated",
  enquiry_status_updated: "Enquiry status updated",
  incoming_webhook: "Incoming webhook",
  recurring: "Recurring (schedule)",
  appointment_created: "Appointment created",
  appointment_updated: "Appointment updated",
};

export const NODE_TYPES = [
  "trigger",
  "message",
  "question",
  "quick_reply",
  "template",
  "branch",
  "wait",
  "office_hours",
  "run_flow",
  "end_flow",
  "assign_to",
  "close_conversation",
  "add_comment",
  "update_contact",
  "enquiry",
  "add_task",
  "portal_record",
  "appointment",
  "api_action",
  "send_notification",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const optId = z.string().trim().min(1).max(80).optional();

export const optionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, "option id: letters, digits, - and _"),
  title: text(ROW_TITLE_MAX),
});
export type FlowOption = z.infer<typeof optionSchema>;

const varName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,39}$/,
    "variable name: letters, digits and _, starting with a letter",
  );

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm");

const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof weekday>;

export const nodeDataSchemas = {
  trigger: z.object({}).passthrough(),
  message: z.object({ text: text(MESSAGE_TEXT_MAX) }),
  question: z
    .object({
      text: text(1024),
      kind: z.enum(["text", "buttons", "list"]),
      options: z.array(optionSchema).max(MAX_LIST_ROWS).default([]),
      listButtonLabel: z.string().trim().min(1).max(20).optional(),
      variable: varName,
      timeoutMinutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_DAYS * 1440)
        .optional(),
    })
    .superRefine((d, ctx) => {
      if (d.kind === "buttons") {
        if (d.options.length < 1 || d.options.length > MAX_BUTTONS)
          ctx.addIssue({
            code: "custom",
            path: ["options"],
            message: `Buttons: 1 to ${MAX_BUTTONS} options`,
          });
        d.options.forEach((o, i) => {
          if (o.title.length > BUTTON_TITLE_MAX)
            ctx.addIssue({
              code: "custom",
              path: ["options", i, "title"],
              message: `Button text is limited to ${BUTTON_TITLE_MAX} characters`,
            });
        });
      }
      if (d.kind === "list" && (d.options.length < 1 || d.options.length > MAX_LIST_ROWS))
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: `List: 1 to ${MAX_LIST_ROWS} rows`,
        });
      if (d.kind === "text" && d.options.length > 0)
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "A free-text question has no options",
        });
      if (new Set(d.options.map((o) => o.id)).size !== d.options.length)
        ctx.addIssue({ code: "custom", path: ["options"], message: "Option ids must be unique" });
    }),
  quick_reply: z
    .object({
      text: text(1024),
      options: z.array(optionSchema).min(1).max(MAX_BUTTONS),
      timeoutMinutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_DAYS * 1440)
        .optional(),
    })
    .superRefine((d, ctx) => {
      d.options.forEach((o, i) => {
        if (o.title.length > BUTTON_TITLE_MAX)
          ctx.addIssue({
            code: "custom",
            path: ["options", i, "title"],
            message: `Button text is limited to ${BUTTON_TITLE_MAX} characters`,
          });
      });
      if (new Set(d.options.map((o) => o.id)).size !== d.options.length)
        ctx.addIssue({ code: "custom", path: ["options"], message: "Option ids must be unique" });
    }),
  template: z.object({
    templateId: z.string().uuid(),
    /** "body.1" → text with {interpolation}. Unmapped variables are an error at send time. */
    values: z.record(z.string(), z.string().max(1024)).default({}),
  }),
  branch: z.object({ conditions: filterSchema }),
  wait: z
    .object({
      amount: z.number().int().min(1),
      unit: z.enum(["seconds", "minutes", "hours", "days"]),
    })
    .refine(
      (d) =>
        d.amount * { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[d.unit] <=
        MAX_WAIT_DAYS * 86400,
      `A wait can be at most ${MAX_WAIT_DAYS} days`,
    ),
  office_hours: z.object({
    timezone: z.string().trim().min(1).max(60).optional(),
    days: z
      .partialRecord(weekday, z.array(z.object({ from: timeOfDay, to: timeOfDay })).max(4))
      .default({}),
  }),
  run_flow: z.object({ flowId: z.string().uuid() }),
  end_flow: z.object({}).passthrough(),
  assign_to: z
    .object({ userId: z.string().uuid().optional(), teamId: z.string().uuid().optional() })
    .refine((d) => !!d.userId || !!d.teamId, "Choose a person or a team"),
  close_conversation: z.object({}).passthrough(),
  add_comment: z.object({ text: text(2000) }),
  update_contact: z.object({
    fields: z
      .array(
        z.object({
          field: z.enum([
            "first_name",
            "last_name",
            "email",
            "gender",
            "language",
            "label",
            "nationality",
          ]),
          value: z.string().max(200),
        }),
      )
      .min(1)
      .max(10),
  }),
  enquiry: z.object({
    action: z.enum(["create", "update"]),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    status: z.enum(["open", "won", "lost"]).optional(),
    subject: z.string().max(200).optional(),
  }),
  add_task: z.object({
    subject: text(200),
    notes: z.string().max(1000).optional(),
    dueInHours: z
      .number()
      .min(0)
      .max(24 * 90)
      .default(24),
    assigneeId: z.string().uuid().optional(),
  }),
  portal_record: z.object({
    objectKey: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/),
    action: z.enum(["create", "update"]),
    recordId: z.string().max(200).optional(),
    values: z.record(z.string(), z.string().max(1000)).default({}),
  }),
  appointment: z.object({
    action: z.enum(["set_status", "create"]),
    status: z.enum(["confirmed", "cancelled"]).optional(),
    appointmentId: z.string().max(200).optional(),
    specialistId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    startsAt: z.string().max(100).optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
  }),
  api_action: z.object({
    method: z.enum(["GET", "POST"]),
    url: z.string().trim().min(1).max(2000),
    headers: z.record(z.string(), z.string().max(500)).default({}),
    body: z.string().max(10000).optional(),
    saveAs: varName.optional(),
  }),
  send_notification: z
    .object({
      userId: z.string().uuid().optional(),
      permission: z.string().max(80).optional(),
      title: text(120),
      body: z.string().max(500).optional(),
    })
    .refine((d) => !!d.userId || !!d.permission, "Choose who to notify"),
} satisfies Record<NodeType, z.ZodType>;

export type NodeData<T extends NodeType> = z.infer<(typeof nodeDataSchemas)[T]>;

export const flowNodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  sourceHandle: z.string().max(80).nullish(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema).max(300),
  edges: z.array(flowEdgeSchema).max(600),
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

export const emptyGraph = (): FlowGraph => ({
  nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} }],
  edges: [],
});

export type TriggerConfig = {
  channel_id?: string;
  pipeline_id?: string;
  cron?: string;
  timezone?: string;
  button_ids?: string[];
};

export type FlowDefinition = {
  id: string;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig;
  conditions: Filter | null;
};

/** Handles a node can leave through; the validator and the builder both use this. */
export function handlesFor(type: NodeType, data: Record<string, unknown> = {}): string[] {
  switch (type) {
    case "end_flow":
    case "run_flow":
      return [];
    case "branch":
      return ["true", "false"];
    case "office_hours":
      return ["inside", "outside"];
    case "api_action":
      return ["default", "fallback"];
    case "question": {
      const opts = (Array.isArray(data.options) ? data.options : []) as Array<{ id?: string }>;
      return ["default", ...opts.filter((o) => o?.id).map((o) => `option:${o.id}`), "fallback"];
    }
    case "quick_reply": {
      const opts = (Array.isArray(data.options) ? data.options : []) as Array<{ id?: string }>;
      return [...opts.filter((o) => o?.id).map((o) => `option:${o.id}`), "default", "fallback"];
    }
    default:
      return ["default"];
  }
}

export const NODE_META: Record<NodeType, { label: string; group: string; description: string }> = {
  trigger: { label: "Trigger", group: "Start", description: "Where the flow starts" },
  message: { label: "Message", group: "Messaging", description: "Send a text message" },
  question: {
    label: "Question",
    group: "Messaging",
    description: "Ask and save the answer to a variable",
  },
  quick_reply: {
    label: "Quick reply",
    group: "Messaging",
    description: "Offer up to 3 buttons and branch on the choice",
  },
  template: {
    label: "Template",
    group: "Messaging",
    description: "Send an approved WhatsApp template",
  },
  branch: { label: "Branch", group: "Logic", description: "Yes / no on conditions" },
  wait: { label: "Wait", group: "Logic", description: "Pause for a while" },
  office_hours: {
    label: "Office hours",
    group: "Logic",
    description: "Inside or outside opening hours",
  },
  run_flow: { label: "Run flow", group: "Logic", description: "Hand over to another flow" },
  end_flow: { label: "End flow", group: "Logic", description: "Stop here" },
  assign_to: {
    label: "Assign to",
    group: "Conversation",
    description: "Assign the conversation to a person or team",
  },
  close_conversation: {
    label: "Close conversation",
    group: "Conversation",
    description: "Close the conversation",
  },
  add_comment: {
    label: "Add comment",
    group: "Conversation",
    description: "Internal note on the conversation",
  },
  update_contact: {
    label: "Update contact field",
    group: "CRM",
    description: "Set fields on the contact",
  },
  enquiry: {
    label: "Create / update enquiry",
    group: "CRM",
    description: "Open an enquiry or move an existing one",
  },
  add_task: { label: "Add task", group: "CRM", description: "Create a task for the team" },
  portal_record: {
    label: "Create / update portal record",
    group: "CRM",
    description: "Write a back-office record",
  },
  appointment: {
    label: "Book / update appointment",
    group: "CRM",
    description: "Create an appointment or confirm / cancel one",
  },
  api_action: { label: "API action", group: "Integrations", description: "Call an HTTPS endpoint" },
  send_notification: {
    label: "Send notification",
    group: "Integrations",
    description: "Notify staff in the app",
  },
};

export function parseNodeData<T extends NodeType>(type: T, data: unknown): NodeData<T> {
  return nodeDataSchemas[type].parse(data) as NodeData<T>;
}
