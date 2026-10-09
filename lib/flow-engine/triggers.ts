/**
 * Turning domain events into flow runs. Listeners only enqueue a `flow_steps` job
 * ({type:'trigger'}); this module runs inside that job:
 *   - message.received  → resume a waiting bot run, else template-button flows
 *   - conversation.*    → conversation_* flows (conditions: Source / Keyword / Ad)
 *   - enquiry.* / appointment.* → matching flows (conditions on source only; payload kept in run.trigger)
 */
import { matchTriggerConditions, type TriggerFacts } from "@/lib/flow-engine/conditions";
import type { FlowDeps, FlowView } from "@/lib/flow-engine/deps";
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
};

/** Events the listener must enqueue (the mapped ones plus inbound messages). */
export function isFlowEvent(name: string): boolean {
  return name === "message.received" || name in EVENT_TRIGGERS;
}

export type TriggerEvent = { orgId: string; name: string; payload: Record<string, unknown> };
export type TriggerOutcome = { started: string[]; resumed: boolean; skipped: string[] };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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

  if (ev.name === "message.received") {
    const messageId = str(ev.payload.message_id);
    const msg = messageId ? await deps.store.getInboundMessage(messageId) : null;
    if (!msg) return out;
    contactId = contactId ?? msg.contact_id;

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
    if (msg.kind !== "button") return out;
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
    });
    if (res.started) {
      out.started.push(res.runId);
      // One bot run per conversation: the first matching flow wins.
      if (conversationId) break;
    } else out.skipped.push(flow.id);
  }
  return out;
}
