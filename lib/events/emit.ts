/**
 * Domain events. Phase 3 ships the emitter and the inbox events, Phase 5 adds the
 * enquiry and task events; Phase 8 attaches flow triggers and outbound webhooks as listeners.
 *
 *   emit(orgId, 'conversation.opened', { conversation_id })
 *
 * Listeners run in-process, in order, and never throw into the emitter: a
 * failing listener is logged and the others still run.
 *
 * Outbound webhooks are NOT a listener: emit() hands every event to
 * lib/webhooks/fanout directly, because in-process listeners only exist in the
 * process that registered them (unreliable on serverless).
 */
export type DomainEventName =
  | "conversation.opened"
  | "conversation.closed"
  | "conversation.waiting"
  | "conversation.assigned"
  | "message.received"
  | "message.sent"
  | "message.failed"
  | "contact.created"
  | "contact.stop_marketing"
  | "channel.quality_changed"
  | "template.status_changed"
  | "enquiry.created"
  | "enquiry.assigned"
  | "enquiry.stage_changed"
  | "enquiry.status_changed"
  | "enquiry.pipeline_changed"
  | "enquiry.sla_breached"
  | "task.created"
  | "task.completed"
  | "task.due"
  | "campaign.started"
  | "campaign.paused"
  | "campaign.resumed"
  | "campaign.completed"
  | "campaign.cancelled"
  | "appointment.created"
  | "appointment.updated"
  | "appointment.status_changed"
  | "appointment.reminder_sent"
  | "appointment.reminder_failed"
  | "portal.record_created"
  | "portal.record_updated"
  | "portal.record_deleted";

export type DomainEvent = {
  orgId: string;
  name: DomainEventName;
  payload: Record<string, unknown>;
  at: Date;
};

export type Listener = (event: DomainEvent) => Promise<void> | void;

const listeners = new Map<string, Listener[]>();

export function on(name: DomainEventName | "*", listener: Listener): () => void {
  const list = listeners.get(name) ?? [];
  list.push(listener);
  listeners.set(name, list);
  return () => {
    const cur = listeners.get(name) ?? [];
    listeners.set(
      name,
      cur.filter((l) => l !== listener),
    );
  };
}

export function clearListeners(): void {
  listeners.clear();
}

export async function emit(
  orgId: string,
  name: DomainEventName,
  payload: Record<string, unknown> = {},
): Promise<DomainEvent> {
  const event: DomainEvent = { orgId, name, payload, at: new Date() };
  const targets = [...(listeners.get(name) ?? []), ...(listeners.get("*") ?? [])];
  for (const l of targets) {
    try {
      await l(event);
    } catch (err) {
      console.error("[events] listener failed", {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await fanoutToWebhooks(event);
  return event;
}

/** Queue outbound webhook deliveries for this event. Skipped without a configured database (tests, build). */
async function fanoutToWebhooks(event: DomainEvent): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  try {
    const { fanoutEvent } = await import("@/lib/webhooks/fanout");
    await fanoutEvent(event);
  } catch (err) {
    // A webhook problem must never break the action that emitted the event.
    console.error("[events] webhook fan-out failed", { name: event.name, error: err instanceof Error ? err.name : "unknown" });
  }
}
