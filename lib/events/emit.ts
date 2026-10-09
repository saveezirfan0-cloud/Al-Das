/**
 * Domain events. Phase 3 ships the emitter and the inbox events, Phase 5 adds the
 * enquiry and task events; Phase 8 attaches flow triggers and outbound webhooks as listeners.
 *
 *   emit(orgId, 'conversation.opened', { conversation_id })
 *
 * Listeners run in-process, in order, and never throw into the emitter: a
 * failing listener is logged and the others still run.
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
  | "task.due";

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
  return event;
}
