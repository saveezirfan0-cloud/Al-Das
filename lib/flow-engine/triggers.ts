/**
 * Turning domain events into flow runs. Listeners only enqueue a `flow_steps` job
 * ({type:'trigger'}); this module runs inside that job:
 *   - message.received  → schedule window_closing checks; resume a waiting bot run, else
 *                         template_button (a template quick-reply), wa_flow_completed (a WhatsApp Flow form),
 *                         or message_received (any other message on a conversation that was already open)
 *   - conversation.*    → conversation_* flows (conditions: Source / Keyword / Ad)
 *   - enquiry.* / appointment.* → matching flows (conditions on source only; payload kept in run.trigger)
 * and the scheduled checks (scheduled_jobs → flow_steps):
 *   - flow.window_closing → handleWindowClosing (no-op when the patient wrote again or the window already closed)
 *   - flow.drip           → handleSegmentJoined (segments.drip_flow_id, static segments only)
 */
import { detectEmergency } from "@/lib/ai/intent/emergency";
import { matchTriggerConditions, type TriggerFacts } from "@/lib/flow-engine/conditions";
import type { FlowDeps, FlowView, InboundMessageView } from "@/lib/flow-engine/deps";
import { resumeFromReply, startRun } from "@/lib/flow-engine/run";
import { triggerConditionsSchema, type TriggerType } from "@/lib/flow-engine/types";

export const EVENT_TRIGGERS: Record<string, TriggerType> = {
  "conversation.opened": "conversation_opened",
  "conversation.closed": "conversation_closed",
  "conversation.waiting": "conversation_waiting",
  "enquiry.created": "enquiry_added",
  "enquiry.stage_changed": "enquiry_stage_updated",
  "enquiry.status_changed": "enquiry_status_updated",
  "appointment.created": "appointment_created",
  "appointment.updated": "appointment_updated",
  "appointment.status_changed": "appointment_status_changed",
  "conversation.ai_tagged": "conversation_ai_tagged",
};

/** Events the listener must enqueue (the mapped ones plus inbound messages). */
export function isFlowEvent(name: string): boolean {
  return name === "message.received" || name in EVENT_TRIGGERS;
}

export type TriggerEvent = { orgId: string; name: string; payload: Record<string, unknown> };
export type TriggerOutcome = { started: string[]; resumed: boolean; skipped: string[] };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The customer-service window Meta gives after the patient's last message. */
export const SERVICE_WINDOW_MS = 24 * 3_600_000;

/** message_received: one burst of messages starts one run. A run of the same flow for the same conversation inside this
 * many seconds blocks a new one (and a live run always owns the conversation). */
export const DEBOUNCE_SECONDS = { default: 120, min: 30, max: 3600 } as const;
/** window_closing: how many minutes before the window ends the flow starts. */
export const WINDOW_LEAD_MINUTES = { default: 60, min: 5, max: 1380 } as const;

/** Inbound kinds that count as "a message" for message_received (not reactions, system notices, template buttons, forms). */
const MESSAGE_KINDS = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
  "interactive",
]);

function clampInt(v: unknown, range: { default: number; min: number; max: number }): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

export function debounceSeconds(cfg: Record<string, unknown>): number {
  return clampInt(cfg.debounce_seconds, DEBOUNCE_SECONDS);
}

export function windowLeadMinutes(cfg: Record<string, unknown>): number {
  return clampInt(cfg.minutes_before, WINDOW_LEAD_MINUTES);
}

/** When the window-closing check for one inbound message should run (null when that moment has already passed). */
export function windowCheckAt(inboundAt: string, minutesBefore: number, now: Date): Date | null {
  const at = Date.parse(inboundAt);
  if (!Number.isFinite(at)) return null;
  const runAt = new Date(at + SERVICE_WINDOW_MS - minutesBefore * 60_000);
  return runAt.getTime() > now.getTime() ? runAt : null;
}

/** Source / Keyword / Ad facts for a conversation-scoped trigger. */
export function factsFromReferral(referral: unknown, keyword: string | null): TriggerFacts {
  const r = (referral && typeof referral === "object" ? referral : null) as Record<
    string,
    unknown
  > | null;
  return {
    source: r ? (str(r.source_url) ?? str(r.source_type) ?? "ad") : "direct",
    keyword,
    ad: r ? str(r.source_id) : null,
  };
}

function conditionsOf(flow: FlowView) {
  const parsed = triggerConditionsSchema.safeParse(flow.trigger_config.conditions ?? {});
  return parsed.success ? parsed.data : null; // malformed conditions never match (fail closed)
}

/** Every inbound message (re)starts the window: one durable check per window_closing flow, deduplicated per message. */
async function scheduleWindowChecks(
  deps: FlowDeps,
  orgId: string,
  msg: InboundMessageView,
): Promise<void> {
  if (!msg.at) return;
  const flows = await deps.store.listActiveFlows(orgId, "window_closing");
  for (const flow of flows) {
    const runAt = windowCheckAt(msg.at, windowLeadMinutes(flow.trigger_config), deps.now());
    if (!runAt) continue;
    await deps.jobs.scheduleTrigger({
      orgId,
      kind: "flow.window_closing",
      payload: { flow_id: flow.id, conversation_id: msg.conversation_id, inbound_at: msg.at },
      runAt,
      dedupeKey: `flow.window:${flow.id}:${msg.id}`,
    });
  }
}

export async function handleTriggerEvent(
  deps: FlowDeps,
  ev: TriggerEvent,
): Promise<TriggerOutcome> {
  const out: TriggerOutcome = { started: [], resumed: false, skipped: [] };
  const conversationId = str(ev.payload.conversation_id);
  let contactId = str(ev.payload.contact_id);

  let triggerType: TriggerType | null = EVENT_TRIGGERS[ev.name] ?? null;
  let facts: TriggerFacts = {};
  let extra: Record<string, unknown> = { ...ev.payload };
  let templateId: string | null = null;
  let buttonText: string | null = null;
  let formToken: string | null = null;
  let vars: Record<string, unknown> | undefined;

  if (ev.name === "message.received") {
    const messageId = str(ev.payload.message_id);
    const msg = messageId ? await deps.store.getInboundMessage(messageId) : null;
    if (!msg) return out;
    contactId = contactId ?? msg.contact_id;

    await scheduleWindowChecks(deps, ev.orgId, msg);

    // A waiting bot run owns the conversation: the message is the answer.
    const live = await deps.store.getLiveRunForConversation(msg.conversation_id);
    if (live) {
      if (live.status === "waiting" && live.waiting_for?.kind === "reply") {
        const kind =
          msg.kind === "button" || (msg.kind === "interactive" && msg.reply_id) ? "button" : "text";
        const r = await resumeFromReply(deps, live.id, {
          kind,
          text: msg.body ?? "",
          optionId: msg.reply_id,
        });
        out.resumed = r.resumed;
      }
      return out;
    }
    if (msg.kind === "button") {
      triggerType = "template_button";
      templateId = msg.template_id;
      buttonText = msg.body;
      extra = {
        ...extra,
        button_text: msg.body,
        button_payload: msg.reply_id,
        template_id: msg.template_id,
      };
      facts = { source: "template", keyword: msg.body, ad: null };
    } else if (msg.form) {
      triggerType = "wa_flow_completed";
      formToken = msg.form_token ?? null;
      vars = { form: msg.form };
      extra = { ...extra, form_token: formToken, form_fields: Object.keys(msg.form).length };
      facts = { source: "whatsapp_flow", keyword: null, ad: null };
    } else {
      // The first message of a conversation belongs to the conversation_opened trigger.
      if (ev.payload.opened === true || !MESSAGE_KINDS.has(msg.kind)) return out;
      // A possible emergency goes to a person (lib/ai/intent); it never starts a flow.
      if (detectEmergency(msg.body).matched) return out;
      const conv = await deps.store.getConversation(msg.conversation_id);
      // A person owns this conversation: the bot does not barge in.
      if (!conv || conv.status === "closed" || conv.assignee_user_id) return out;
      triggerType = "message_received";
      facts = factsFromReferral(conv.ad_referral, msg.body);
    }
  } else if (triggerType && conversationId) {
    const conv = await deps.store.getConversation(conversationId);
    if (!conv) return out;
    contactId = contactId ?? conv.contact_id;
    facts = factsFromReferral(
      conv.ad_referral,
      await deps.store.getFirstInboundText(conversationId),
    );
    if (ev.name === "conversation.opened" && ev.payload.ad_referral) {
      facts = factsFromReferral(ev.payload.ad_referral, facts.keyword ?? null);
    }
  } else if (triggerType) {
    facts = { source: str(ev.payload.source), keyword: null, ad: null };
  }
  if (!triggerType) return out;

  const flows = await deps.store.listActiveFlows(ev.orgId, triggerType);
  const channelId = conversationId
    ? ((await deps.store.getConversation(conversationId))?.channel_id ?? null)
    : null;
  for (const flow of flows) {
    if (flow.channel_id && channelId && flow.channel_id !== channelId) {
      out.skipped.push(flow.id);
      continue;
    }
    if (triggerType === "template_button") {
      const wantTemplate = str(flow.trigger_config.template_id);
      const wantButton = str(flow.trigger_config.button_text);
      if (wantTemplate && wantTemplate !== templateId) {
        out.skipped.push(flow.id);
        continue;
      }
      if (wantButton && wantButton.toLowerCase() !== (buttonText ?? "").trim().toLowerCase()) {
        out.skipped.push(flow.id);
        continue;
      }
    }
    if (triggerType === "wa_flow_completed") {
      const wantToken = str(flow.trigger_config.flow_token);
      if (wantToken && wantToken !== formToken) {
        out.skipped.push(flow.id);
        continue;
      }
    }
    if (triggerType === "message_received" && conversationId) {
      const since = new Date(deps.now().getTime() - debounceSeconds(flow.trigger_config) * 1000);
      if (await deps.store.hasRunSince(flow.id, conversationId, since)) {
        out.skipped.push(flow.id);
        continue;
      }
    }
    if (triggerType === "conversation_ai_tagged") {
      // The flow names the tags it reacts to; it starts only when one of them was just added.
      const wanted = Array.isArray(flow.trigger_config.tags)
        ? (flow.trigger_config.tags as unknown[])
        : [];
      const added = Array.isArray(ev.payload.tags) ? (ev.payload.tags as unknown[]) : [];
      if (!wanted.some((t) => typeof t === "string" && added.includes(t))) {
        out.skipped.push(flow.id);
        continue;
      }
    }
    const cond = conditionsOf(flow);
    if (!cond || !matchTriggerConditions(cond, facts)) {
      out.skipped.push(flow.id);
      continue;
    }
    const res = await startRun(deps, {
      flowId: flow.id,
      contactId,
      conversationId,
      enquiryId: str(ev.payload.enquiry_id),
      trigger: { event: ev.name, ...extra, facts },
      vars,
    });
    if (res.started) {
      out.started.push(res.runId);
      // One bot run per conversation: the first matching flow wins.
      if (conversationId) break;
    } else out.skipped.push(flow.id);
  }
  return out;
}

export type ScheduledOutcome = { started: boolean; reason: string; runId?: string };

/**
 * flow.window_closing fired. Re-checks everything at fire time: the flow is still an active window_closing flow, the
 * conversation is open, NO newer inbound message arrived since the one that scheduled this check (a reply makes it a no-op;
 * that reply scheduled its own check), and the window has not already closed.
 */
export async function handleWindowClosing(
  deps: FlowDeps,
  input: { orgId: string; flowId: string; conversationId: string; inboundAt: string },
): Promise<ScheduledOutcome> {
  const flow = await deps.store.getFlow(input.flowId);
  if (
    !flow ||
    flow.org_id !== input.orgId ||
    flow.status !== "active" ||
    flow.trigger_type !== "window_closing"
  )
    return { started: false, reason: "flow_inactive" };
  const conv = await deps.store.getConversation(input.conversationId);
  if (!conv || conv.org_id !== input.orgId) return { started: false, reason: "no_conversation" };
  if (conv.status === "closed") return { started: false, reason: "closed" };
  const scheduledFor = Date.parse(input.inboundAt);
  const last = conv.last_inbound_at ? Date.parse(conv.last_inbound_at) : NaN;
  if (!Number.isFinite(scheduledFor)) return { started: false, reason: "bad_payload" };
  if (Number.isFinite(last) && last > scheduledFor)
    return { started: false, reason: "newer_inbound" };
  const windowEnds = Math.max(scheduledFor, Number.isFinite(last) ? last : 0) + SERVICE_WINDOW_MS;
  if (deps.now().getTime() >= windowEnds) return { started: false, reason: "window_closed" };
  if (flow.channel_id && flow.channel_id !== conv.channel_id)
    return { started: false, reason: "other_number" };
  const cond = conditionsOf(flow);
  const facts = factsFromReferral(conv.ad_referral, await deps.store.getFirstInboundText(conv.id));
  if (!cond || !matchTriggerConditions(cond, facts))
    return { started: false, reason: "conditions" };
  const res = await startRun(deps, {
    flowId: flow.id,
    contactId: conv.contact_id,
    conversationId: conv.id,
    trigger: {
      event: "window_closing",
      conversation_id: conv.id,
      window_ends_at: new Date(windowEnds).toISOString(),
      facts,
    },
  });
  return res.started
    ? { started: true, reason: "started", runId: res.runId }
    : { started: false, reason: res.reason };
}

/**
 * flow.drip fired (a contact joined a static segment; queued by the segment_members trigger). Re-checks at fire time: the
 * segment still names this flow as its drip, it is static, the contact is still a live member, the flow is an active
 * segment_joined flow. The run has no conversation (like Recurring): use Template nodes to reach the patient.
 */
export async function handleSegmentJoined(
  deps: FlowDeps,
  input: { orgId: string; segmentId: string; contactId: string; flowId: string },
): Promise<ScheduledOutcome> {
  const seg = await deps.store.getSegmentDrip(input.segmentId, input.contactId);
  if (!seg || seg.org_id !== input.orgId) return { started: false, reason: "no_segment" };
  if (seg.kind !== "static") return { started: false, reason: "not_static" };
  if (seg.drip_flow_id !== input.flowId) return { started: false, reason: "drip_changed" };
  if (!seg.member) return { started: false, reason: "not_a_member" };
  const flow = await deps.store.getFlow(input.flowId);
  if (
    !flow ||
    flow.org_id !== input.orgId ||
    flow.status !== "active" ||
    flow.trigger_type !== "segment_joined"
  )
    return { started: false, reason: "flow_inactive" };
  const res = await startRun(deps, {
    flowId: flow.id,
    contactId: input.contactId,
    conversationId: null,
    trigger: { event: "segment_joined", segment_id: input.segmentId },
  });
  return res.started
    ? { started: true, reason: "started", runId: res.runId }
    : { started: false, reason: res.reason };
}
