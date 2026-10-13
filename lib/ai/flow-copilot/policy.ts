import type { NodeType, TriggerType } from "@/lib/flow-engine/types";

/**
 * What the Flow Copilot may put in a draft. This is deliberately narrower than the builder:
 *
 *  - api_action   would let a prompt (or a prompt injected into it) send patient data to an arbitrary URL. The SSRF guard
 *                 only protects OUR network; it cannot know a destination is hostile. Never generated, always stripped.
 *  - portal_record, run_flow, book_appointment, create_enquiry, update_enquiry, add_task, set_label   need ids (pipelines,
 *                 stages, labels, services, objects) the model cannot know. A person adds them by hand.
 *  - payment_link, meta_event   take money or send data to Meta: always a person's decision.
 *  - ai_router    a person decides which labels a flow acts on (the router itself never writes model text).
 *
 * Triggers that start without a person present (an incoming webhook, a recurring schedule) are also left to people.
 */
export const AI_NODE_TYPES: readonly NodeType[] = [
  "trigger",
  "message",
  "question",
  "quick_reply",
  "template",
  "branch",
  "wait",
  "office_hours",
  "end_flow",
  "assign_to",
  "close_conversation",
  "add_comment",
  "update_contact_field",
  "send_notification",
];

/** Node types that are removed from a draft (with a note) rather than rejected, because a person can add them by hand. */
export const STRIPPED_NODE_TYPES: readonly NodeType[] = [
  "api_action",
  "portal_record",
  "run_flow",
  "book_appointment",
  "create_enquiry",
  "add_task",
  "update_enquiry",
  "set_label",
  "payment_link",
  "meta_event",
  "ai_router",
];

export const AI_TRIGGER_TYPES: readonly TriggerType[] = [
  "conversation_opened",
  "conversation_closed",
  "conversation_waiting",
  "template_button",
  "shortcut",
  "enquiry_added",
  "enquiry_stage_updated",
  "enquiry_status_updated",
  "appointment_created",
  "appointment_updated",
  "appointment_status_changed",
];

export const AI_FLOW_LIMITS = {
  /** The raw model reply, in characters, before anything is parsed. */
  maxRawChars: 60_000,
  maxNodes: 40,
  maxEdges: 80,
  maxIdLength: 40,
  maxMessageChars: 1024,
  maxCommentChars: 500,
  maxPromptChars: 1500,
  /** A wait longer than this needs a person to decide it. */
  maxWaitDays: 30,
} as const;

/** Contact fields a draft may write. Everything else (name, e-mail, gender, custom fields) is a person's decision. */
export const AI_CONTACT_FIELDS = ["label", "language"] as const;
