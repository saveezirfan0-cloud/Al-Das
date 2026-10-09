/**
 * Starter flows ("Start from a template" in the New flow dialog). Original wording, no clinical
 * advice. Each one needs something filled in before it can be published (a template, a team, an
 * approved reply); the validator says exactly what, so nothing goes live half-configured.
 */
import { and, cond, type Filter } from "@/lib/filters/ast";
import type { FlowGraph, TriggerConfig, TriggerType } from "@/lib/flow-engine/types";

export type FlowStarter = {
  key: string;
  name: string;
  description: string;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  conditions: Filter | null;
  graph: FlowGraph;
  /** What the person has to choose before publishing. */
  needs: string[];
};

const n = (
  id: string,
  type: FlowGraph["nodes"][number]["type"],
  x: number,
  y: number,
  data: Record<string, unknown> = {},
) => ({ id, type, position: { x, y }, data });
const e = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}>${target}${sourceHandle ? `:${sourceHandle}` : ""}`,
  source,
  target,
  sourceHandle: sourceHandle ?? null,
});

const WEEK = (from: string, to: string) =>
  Object.fromEntries(
    (["mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d) => [d, [{ from, to }]]),
  );

export const FLOW_STARTERS: readonly FlowStarter[] = [
  {
    key: "welcome_office_hours",
    name: "Welcome and office hours",
    description:
      "Greets a new conversation. Inside opening hours it hands over to a team; outside them it says when we reply and leaves a task for the morning.",
    trigger_type: "conversation_opened",
    trigger_config: {},
    conditions: null,
    needs: ["Choose the team that answers during opening hours", "Check the opening hours"],
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 120),
        n("hours", "office_hours", 280, 100, { days: WEEK("09:00", "18:00") }),
        n("hello", "message", 640, 0, {
          text: 'Hello {contact.first_name|default:"there"}, thank you for contacting us. A member of our team will reply shortly.',
        }),
        n("assign", "assign_to", 960, 0, {}),
        n("closed", "message", 640, 240, {
          text: 'Hello {contact.first_name|default:"there"}, thank you for your message. Our team is offline right now and will reply when we open.',
        }),
        n("task", "add_task", 960, 240, {
          subject: "Reply to {contact.first_name} (messaged outside opening hours)",
          dueInHours: 12,
        }),
      ],
      edges: [
        e("trigger", "hours"),
        e("hours", "hello", "inside"),
        e("hello", "assign"),
        e("hours", "closed", "outside"),
        e("closed", "task"),
      ],
    },
  },
  {
    key: "no_show_follow_up",
    name: "Missed appointment follow-up",
    description:
      "A day after an appointment is marked no-show, sends an approved template and asks reception to call.",
    trigger_type: "appointment_updated",
    trigger_config: {},
    conditions: { include: and(cond("appointment.status", "eq", "no_show")), exclude: null },
    needs: [
      "Choose the approved template to send",
      "Choose the number to send from (in Trigger settings)",
    ],
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 80),
        n("wait", "wait", 280, 60, { amount: 1, unit: "days" }),
        n("template", "template", 600, 40, {
          templateId: "",
          values: { "body.1": '{contact.first_name|default:"there"}' },
        }),
        n("task", "add_task", 920, 60, {
          subject: "Call {contact.first_name} to rebook after a missed appointment",
          dueInHours: 24,
        }),
      ],
      edges: [e("trigger", "wait"), e("wait", "template"), e("template", "task")],
    },
  },
  {
    key: "post_visit_check_in",
    name: "After-visit check-in",
    description:
      "The day after a completed visit, asks how it went with three buttons. A poor answer notifies the team and creates a call task.",
    trigger_type: "appointment_updated",
    trigger_config: {},
    conditions: { include: and(cond("appointment.status", "eq", "completed")), exclude: null },
    needs: [
      "Choose the approved template that opens the conversation",
      "Choose who is notified about poor answers",
    ],
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 160),
        n("wait", "wait", 260, 140, { amount: 1, unit: "days" }),
        n("template", "template", 560, 120, {
          templateId: "",
          values: { "body.1": '{contact.first_name|default:"there"}' },
        }),
        n("ask", "question", 880, 80, {
          text: "How was your visit?",
          kind: "buttons",
          options: [
            { id: "great", title: "Great" },
            { id: "okay", title: "Okay" },
            { id: "poor", title: "Not good" },
          ],
          variable: "visit_feedback",
          timeoutMinutes: 2880,
        }),
        n("thanks", "message", 1260, 0, { text: "Thank you, we are glad to hear it." }),
        n("notify", "send_notification", 1260, 200, {
          permission: "",
          title: "Poor visit feedback from {contact.first_name}",
        }),
        n("task", "add_task", 1560, 200, {
          subject: "Call {contact.first_name}: unhappy after a visit",
          dueInHours: 24,
        }),
      ],
      edges: [
        e("trigger", "wait"),
        e("wait", "template"),
        e("template", "ask"),
        e("ask", "thanks", "option:great"),
        e("ask", "thanks", "option:okay"),
        e("ask", "notify", "option:poor"),
        e("notify", "task"),
      ],
    },
  },
  {
    key: "webhook_notice",
    name: "Notice from another system",
    description:
      "Another system (a lab, billing, a form) posts to this flow's address with the patient's phone; the patient gets an approved template and the team gets a note.",
    trigger_type: "incoming_webhook",
    trigger_config: {},
    conditions: null,
    needs: [
      "Choose the approved template and number",
      "Generate the webhook address in Trigger settings",
    ],
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 40),
        n("template", "template", 280, 20, {
          templateId: "",
          values: { "body.1": '{contact.first_name|default:"there"}' },
        }),
        n("note", "add_comment", 600, 40, {
          text: 'Notice sent from an outside system. Reference: {event.body.reference|default:"none"}',
        }),
      ],
      edges: [e("trigger", "template"), e("template", "note")],
    },
  },
];

export function starterByKey(key: string | null | undefined): FlowStarter | undefined {
  return FLOW_STARTERS.find((s) => s.key === key);
}
