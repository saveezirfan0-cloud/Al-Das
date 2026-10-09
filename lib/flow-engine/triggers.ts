/**
 * Which flows an event can start. Pure: the dispatcher loads candidate flows and event context
 * and these functions decide.
 */
import type { TriggerConfig, TriggerType } from "@/lib/flow-engine/types";

export type EventPayload = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Interactive replies (button / list row) arrive as message.received with `interactive`. */
export function buttonReplyOf(
  payload: EventPayload,
): { id: string | null; title: string | null } | null {
  const i = payload.interactive as { id?: unknown; title?: unknown } | null | undefined;
  if (i && (str(i.id) || str(i.title))) return { id: str(i.id), title: str(i.title) };
  if (payload.kind === "button") return { id: null, title: null };
  return null;
}

export function triggerTypesFor(name: string, payload: EventPayload): TriggerType[] {
  switch (name) {
    case "conversation.opened":
      return ["conversation_opened"];
    case "conversation.closed":
      return ["conversation_closed"];
    case "conversation.waiting":
      return ["conversation_waiting"];
    case "message.received":
      return buttonReplyOf(payload) ? ["template_button_reply"] : [];
    case "enquiry.created":
      return ["enquiry_added"];
    case "enquiry.stage_changed":
      return ["enquiry_stage_updated"];
    case "enquiry.status_changed":
      return ["enquiry_status_updated"];
    case "appointment.created":
      return ["appointment_created"];
    case "appointment.updated":
    case "appointment.status_changed":
      return ["appointment_updated"];
    default:
      return [];
  }
}

/** Events that can matter to flows at all (emit() only enqueues these). */
export const FLOW_EVENTS: ReadonlySet<string> = new Set([
  "conversation.opened",
  "conversation.closed",
  "conversation.waiting",
  "message.received",
  "enquiry.created",
  "enquiry.stage_changed",
  "enquiry.status_changed",
  "appointment.created",
  "appointment.updated",
  "appointment.status_changed",
]);

/** The flow's own settings (number, pipeline, button ids) against the event. */
export function configMatches(
  config: TriggerConfig,
  channelId: string | null,
  payload: EventPayload,
): boolean {
  if (config.channel_id && channelId && config.channel_id !== channelId) return false;
  if (config.channel_id && !channelId) return false;
  if (config.pipeline_id && str(payload.pipeline_id) !== config.pipeline_id) return false;
  if (config.button_ids?.length) {
    const b = buttonReplyOf(payload);
    const ok =
      !!b &&
      config.button_ids.some((x) => x === b.id || x.toLowerCase() === b.title?.toLowerCase());
    if (!ok) return false;
  }
  return true;
}

/** Idempotency key: the same event delivered twice must start a flow once. */
export function eventTriggerKey(name: string, payload: EventPayload, at: string): string {
  const entity =
    str(payload.message_id) ??
    str(payload.appointment_id) ??
    str(payload.enquiry_id) ??
    str(payload.conversation_id) ??
    "-";
  const extra = str(payload.to_stage_id) ?? str(payload.to) ?? "";
  return `${name}:${entity}:${extra}:${at}`.slice(0, 200);
}

/** Small, flat copy of the payload for {event.*}; nothing nested deeper than it needs to be. */
export function trimEvent(
  payload: EventPayload,
  extra: EventPayload = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (src: unknown, depth: number): unknown => {
    if (typeof src === "string") return src.slice(0, 500);
    if (typeof src === "number" || typeof src === "boolean" || src === null) return src;
    if (depth >= 4) return null;
    if (Array.isArray(src)) return src.slice(0, 20).map((x) => walk(x, depth + 1));
    if (src && typeof src === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src as Record<string, unknown>).slice(0, 50))
        o[k] = walk(v, depth + 1);
      return o;
    }
    return null;
  };
  for (const [k, v] of Object.entries({ ...payload, ...extra }).slice(0, 60)) out[k] = walk(v, 0);
  return out;
}
