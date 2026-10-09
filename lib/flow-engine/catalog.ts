/** Node catalogue shared by the builder (palette, node cards, defaults) and tests. Framework-free. */
import type { NodeType } from "@/lib/flow-engine/types";

export type NodeGroup = "Messaging" | "Logic" | "Conversation" | "CRM" | "Integrations";

export type NodeDef = {
  type: Exclude<NodeType, "trigger">;
  label: string;
  group: NodeGroup;
  description: string;
  keywords: string[];
  defaults: Record<string, unknown>;
};

export const NODE_DEFS: readonly NodeDef[] = [
  {
    type: "message",
    label: "Message",
    group: "Messaging",
    description: "Send a text message (needs an open 24h window).",
    keywords: ["text", "send", "reply"],
    defaults: { text: "Hello {contact.first_name}" },
  },
  {
    type: "question",
    label: "Question",
    group: "Messaging",
    description: "Ask something and wait for the answer (buttons, list or free text).",
    keywords: ["ask", "buttons", "list", "wait for reply"],
    defaults: {
      text: "Would you like to book a visit?",
      style: "buttons",
      options: [
        { id: "yes", title: "Yes" },
        { id: "no", title: "No" },
      ],
      variable: "answer",
    },
  },
  {
    type: "quick_reply",
    label: "Quick reply",
    group: "Messaging",
    description: "Send a message with up to 3 quick-reply buttons and carry on.",
    keywords: ["buttons"],
    defaults: { text: "How can we help?", buttons: [{ id: "book", title: "Book" }] },
  },
  {
    type: "template",
    label: "Template",
    group: "Messaging",
    description: "Send an approved WhatsApp template (works outside the 24h window).",
    keywords: ["whatsapp", "approved", "broadcast"],
    defaults: { template_id: "", values: {} },
  },
  {
    type: "branch",
    label: "Branch",
    group: "Logic",
    description: "Route on a variable, contact field or earlier answer (true / false).",
    keywords: ["if", "condition", "split"],
    defaults: { logic: "and", conditions: [{ left: "vars.answer", op: "eq", right: "" }] },
  },
  {
    type: "wait",
    label: "Wait",
    group: "Logic",
    description: "Pause the flow for a while (resumes from a scheduled job).",
    keywords: ["delay", "timer", "pause"],
    defaults: { amount: 1, unit: "hours" },
  },
  {
    type: "office_hours",
    label: "Office hours",
    group: "Logic",
    description: "Route by whether the clinic is open (inside / outside).",
    keywords: ["open", "closed", "schedule", "hours"],
    defaults: {
      timezone: "Asia/Dubai",
      schedule: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "13:00" }],
        sat: [{ start: "09:00", end: "18:00" }],
      },
    },
  },
  {
    type: "run_flow",
    label: "Run flow",
    group: "Logic",
    description: "Run another published flow, then continue here.",
    keywords: ["subflow", "nested", "call"],
    defaults: { flow_id: "" },
  },
  {
    type: "end_flow",
    label: "End flow",
    group: "Logic",
    description: "Finish the flow.",
    keywords: ["stop", "finish"],
    defaults: {},
  },
  {
    type: "assign_to",
    label: "Assign to",
    group: "Conversation",
    description: "Hand the conversation to a person or team (ends the bot) or to the bot.",
    keywords: ["handover", "agent", "team"],
    defaults: { target: { type: "team", id: "" } },
  },
  {
    type: "close_conversation",
    label: "Close conversation",
    group: "Conversation",
    description: "Close the conversation and end the flow.",
    keywords: ["resolve"],
    defaults: {},
  },
  {
    type: "add_comment",
    label: "Add comment",
    group: "Conversation",
    description: "Leave an internal note for the team.",
    keywords: ["note", "internal"],
    defaults: { text: "Bot note" },
  },
  {
    type: "update_contact_field",
    label: "Update contact field",
    group: "CRM",
    description: "Set a contact field or custom field.",
    keywords: ["crm", "patient", "label", "email"],
    defaults: { field: "label", value: "" },
  },
  {
    type: "create_enquiry",
    label: "Create / update enquiry",
    group: "CRM",
    description: "Create or move an enquiry (available when Enquiries is installed).",
    keywords: ["lead", "pipeline", "stage"],
    defaults: {},
  },
  {
    type: "add_task",
    label: "Add task",
    group: "CRM",
    description: "Create a task for the team (available when Tasks is installed).",
    keywords: ["todo", "reminder"],
    defaults: {},
  },
  {
    type: "portal_record",
    label: "Portal record",
    group: "CRM",
    description: "Create or update a back-office record (available with the Portal).",
    keywords: ["airtable", "back office"],
    defaults: {},
  },
  {
    type: "book_appointment",
    label: "Book / update appointment",
    group: "CRM",
    description: "Book or change an appointment (available with Appointments).",
    keywords: ["booking", "calendar"],
    defaults: {},
  },
  {
    type: "api_action",
    label: "API action",
    group: "Integrations",
    description: "Call an HTTPS API and use the response in later steps.",
    keywords: ["http", "webhook", "request"],
    defaults: { method: "POST", url: "https://", headers: {}, body: "", timeout_seconds: 10 },
  },
  {
    type: "send_notification",
    label: "Send notification",
    group: "Integrations",
    description: "Notify a person, team or role inside Pulse.",
    keywords: ["alert", "notify"],
    defaults: { target: { type: "role", id: "Manager" }, title: "Needs attention", body: "" },
  },
];

export const NODE_GROUPS: readonly NodeGroup[] = [
  "Messaging",
  "Logic",
  "Conversation",
  "CRM",
  "Integrations",
];

export function defFor(type: string): NodeDef | undefined {
  return NODE_DEFS.find((d) => d.type === type);
}

export function searchNodes(query: string): NodeDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...NODE_DEFS];
  return NODE_DEFS.filter((d) =>
    [d.label, d.group, d.description, ...d.keywords].some((s) => s.toLowerCase().includes(q)),
  );
}

/** Output handles of a node as the canvas draws them (id + label). */
export function outputsFor(
  type: string,
  data: Record<string, unknown>,
): Array<{ id: string; label: string }> {
  switch (type) {
    case "end_flow":
      return [];
    case "close_conversation":
      return [];
    case "branch":
      return [
        { id: "true", label: "True" },
        { id: "false", label: "False" },
        { id: "fallback", label: "On error" },
      ];
    case "office_hours":
      return [
        { id: "inside", label: "Inside" },
        { id: "outside", label: "Outside" },
      ];
    case "question": {
      const opts = (Array.isArray(data.options) ? data.options : []) as Array<{
        id: string;
        title: string;
      }>;
      const style = data.style === "text" ? "text" : "choice";
      return [
        ...(style === "choice"
          ? opts.map((o) => ({ id: `option:${o.id}`, label: o.title || o.id }))
          : [{ id: "default", label: "Answered" }]),
        { id: "fallback", label: "No / other answer" },
      ];
    }
    case "wait":
    case "trigger":
      return [{ id: "default", label: "Next" }];
    default:
      return [
        { id: "default", label: "Next" },
        { id: "fallback", label: "On error" },
      ];
  }
}
