/**
 * Starter flows: the native replacements for Sanoflow / Make flow-shaped scenarios. They are created as
 * drafts; steps that need a choice (template, team) are flagged by the builder until the clinic fills them in.
 * Original wording; edit freely.
 */
import type { FlowGraph, TriggerType } from "@/lib/flow-engine/types";

export type StarterFlow = {
  key: string;
  name: string;
  description: string;
  /** Which Make scenario / Sanoflow flow this replaces. */
  replaces: string;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  graph: FlowGraph;
};

const n = (
  id: string,
  type: FlowGraph["nodes"][number]["type"],
  x: number,
  y: number,
  data: Record<string, unknown> = {},
) => ({ id, type, position: { x, y }, data });
const e = (source: string, target: string, handle = "default") => ({
  id: `${source}-${handle}-${target}`,
  source,
  target,
  sourceHandle: handle,
});

export const STARTER_FLOWS: readonly StarterFlow[] = [
  {
    key: "birthday_offer_followup",
    name: "Birthday offer: patient taps “Claim offer”",
    description:
      "Thanks the patient, tells reception, and leaves a note. The recall engine records the outcome as “offer redeemed”.",
    replaces: "Make “Birthday Offer Update” webhook",
    trigger_type: "template_button",
    trigger_config: { button_text: "Claim offer", conditions: { logic: "and", conditions: [] } },
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 120),
        n("thanks", "message", 300, 120, {
          text: "Thank you, {contact.first_name}! Show this message at reception and we will apply your birthday offer.",
        }),
        n("note", "add_comment", 620, 60, {
          text: "Patient claimed the birthday offer. Please apply it at check-in.",
        }),
        n("alert", "send_notification", 620, 220, {
          target: { type: "role", id: "Receptionist" },
          title: "Birthday offer claimed",
          body: "A patient tapped Claim offer.",
        }),
        n("end", "end_flow", 940, 140),
      ],
      edges: [
        e("trigger", "thanks"),
        e("thanks", "note"),
        e("thanks", "end", "fallback"),
        e("note", "alert"),
        e("alert", "end"),
      ],
    },
  },
  {
    key: "recall_book_now",
    name: "Recall: patient taps “Book now”",
    description:
      "Opens an enquiry (when Enquiries is installed), tells the care team and reassures the patient.",
    replaces: "Make “Chronic Update” (booking intent) and the Sanoflow follow-up flow",
    trigger_type: "template_button",
    trigger_config: { button_text: "Book now", conditions: { logic: "and", conditions: [] } },
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 120),
        n("enquiry", "create_enquiry", 300, 120, { title: "Recall: wants to book" }),
        n("reply", "message", 620, 60, {
          text: "Thanks, {contact.first_name}. Our team will contact you shortly to find a time that suits you.",
        }),
        n("alert", "send_notification", 620, 220, {
          target: { type: "role", id: "Manager" },
          title: "Recall: patient wants to book",
          body: "Please call back.",
        }),
        n("end", "end_flow", 940, 140),
      ],
      // If Enquiries is not installed yet the step fails and the flow still notifies the team.
      edges: [
        e("trigger", "enquiry"),
        e("enquiry", "reply"),
        e("enquiry", "alert", "fallback"),
        e("reply", "alert"),
        e("alert", "end"),
      ],
    },
  },
  {
    key: "inbound_routing",
    name: "Inbound routing by office hours",
    description:
      "New conversations get a greeting. Inside office hours they go to the front desk; outside, the patient is told when we reply.",
    replaces: "Sanoflow “Conversation Opened” routing flow",
    trigger_type: "conversation_opened",
    trigger_config: { conditions: { logic: "and", conditions: [] } },
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 160),
        n("hours", "office_hours", 280, 160, {
          timezone: "Asia/Dubai",
          schedule: Object.fromEntries(
            ["mon", "tue", "wed", "thu", "sat"]
              .map((d) => [d, [{ start: "09:00", end: "18:00" }]])
              .concat([["fri", [{ start: "09:00", end: "13:00" }]]]),
          ),
        }),
        n("hello", "message", 600, 60, {
          text: "Hello {contact.first_name}, thanks for contacting us. A member of our team will be with you shortly.",
        }),
        n("team", "assign_to", 920, 60, { target: { type: "team", id: "" } }),
        n("closed", "message", 600, 260, {
          text: "Hello {contact.first_name}, we are closed right now. We will reply when we open.",
        }),
        n("team2", "assign_to", 920, 260, { target: { type: "team", id: "" } }),
      ],
      edges: [
        e("trigger", "hours"),
        e("hours", "hello", "inside"),
        e("hours", "closed", "outside"),
        e("hello", "team"),
        e("hello", "team", "fallback"),
        e("closed", "team2"),
        e("closed", "team2", "fallback"),
      ].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i),
    },
  },
  {
    key: "post_visit_followup",
    name: "After a visit: check-in at day 1 and day 7",
    description:
      "Sends a check-in template the day after a completed visit and again a week later, with a staff alert if the patient replies unhappy.",
    replaces: "Make draft “Post-Appointment Follow-up”",
    trigger_type: "appointment_status_changed",
    trigger_config: {},
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 120),
        n("w1", "wait", 280, 120, { amount: 1, unit: "days" }),
        n("t1", "template", 560, 120, { template_id: "", values: {} }),
        n("w7", "wait", 840, 120, { amount: 6, unit: "days" }),
        n("t7", "template", 1120, 120, { template_id: "", values: {} }),
      ],
      edges: [e("trigger", "w1"), e("w1", "t1"), e("t1", "w7"), e("w7", "t7")],
    },
  },
  {
    key: "no_show_recovery",
    name: "No-show recovery",
    description:
      "Two hours after a missed appointment, offers to rebook; if the patient asks to rebook the team is alerted.",
    replaces: "Make draft “NoShow_Recovery”",
    trigger_type: "appointment_status_changed",
    trigger_config: {},
    graph: {
      nodes: [
        n("trigger", "trigger", 0, 140),
        n("w", "wait", 280, 140, { amount: 2, unit: "hours" }),
        n("t", "template", 560, 140, { template_id: "", values: {} }),
        n("q", "question", 840, 140, {
          text: "Would you like us to find you a new time?",
          style: "buttons",
          options: [
            { id: "yes", title: "Yes, please" },
            { id: "no", title: "Not now" },
          ],
          variable: "rebook",
          timeout_seconds: 86400,
        }),
        n("alert", "send_notification", 1160, 60, {
          target: { type: "role", id: "Receptionist" },
          title: "Missed appointment: patient wants to rebook",
          body: "Please call to rebook.",
        }),
        n("end", "end_flow", 1160, 240),
      ],
      edges: [
        e("trigger", "w"),
        e("w", "t"),
        e("t", "q"),
        e("q", "alert", "option:yes"),
        e("q", "end", "option:no"),
        e("q", "end", "fallback"),
        e("alert", "end"),
      ].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i),
    },
  },
];

export function starterFlow(key: string): StarterFlow | undefined {
  return STARTER_FLOWS.find((f) => f.key === key);
}
