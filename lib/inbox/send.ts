import "server-only";

import { z } from "zod";

import { enqueue } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { previewFor } from "@/lib/whatsapp/parse";
import type { InteractiveObject } from "@/lib/whatsapp/types";

/**
 * What an outbound message row carries in payload.send until the outbound
 * handler turns it into a Cloud API call. Kept small and serialisable.
 */
export const sendSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    body: z.string().min(1).max(4096),
    preview_url: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("media"),
    media_type: z.enum(["image", "video", "audio", "document", "sticker"]),
    media_path: z.string().min(1),
    mime_type: z.string().min(1),
    filename: z.string().optional(),
    caption: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal("template"),
    template_id: z.string().uuid(),
    values: z.record(z.string(), z.string()).default({}),
    /** Set only by the Inbox template send and the public API: allows an Authentication (code) template. */
    otp: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("interactive"), interactive: z.custom<InteractiveObject>() }),
  z.object({ type: z.literal("reaction"), wa_message_id: z.string().min(1), emoji: z.string() }),
  z.object({
    type: z.literal("location"),
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
  }),
  // G11: a contact card (WhatsApp `contacts` message). Built by buildContactCard (lib/inbox/extras.ts).
  z.object({
    type: z.literal("contacts"),
    contacts: z
      .array(
        z.object({
          name: z.object({
            formatted_name: z.string().min(1).max(200),
            first_name: z.string().max(100).optional(),
            last_name: z.string().max(100).optional(),
          }),
          phones: z
            .array(
              z.object({ phone: z.string().min(1).max(32), type: z.string().max(20).optional() }),
            )
            .max(1)
            .optional(),
          org: z.object({ company: z.string().max(100).optional() }).optional(),
        }),
      )
      .min(1)
      .max(1),
  }),
]);

export type SendSpec = z.infer<typeof sendSpecSchema>;

export function kindForSpec(spec: SendSpec): Tables<"messages">["kind"] {
  switch (spec.type) {
    case "text":
      return "text";
    case "media":
      return spec.media_type;
    case "template":
      return "template";
    case "interactive":
      return "interactive";
    case "reaction":
      return "reaction";
    case "location":
      return "location";
    case "contacts":
      return "contacts";
  }
}

/**
 * Why an automation queued a message, stored at messages.payload.context (never inside the send spec, whose schema strips
 * unknown keys). The Sanoflow sender reads it after the send (docs/49 D9, D11); ids and words only, never patient data.
 */
export type OutboundContext =
  | { kind: "appointment_reminder" }
  | { kind: "recall"; programme: "birthday" | "chronic_90d"; live: boolean };

export type QueueOutboundInput = {
  orgId: string;
  conversationId: string;
  spec: SendSpec;
  /** Text shown in the thread / preview (template body text, caption, etc.). */
  body: string | null;
  sentByUserId: string | null;
  replyToWaMessageId?: string | null;
  flowRunId?: string | null;
  campaignRecipientId?: string | null;
  /** Live chat → outbound_priority; campaigns/automations → outbound. */
  priority?: boolean;
  /**
   * Phase 20d retry-on-fail: this message re-sends a failed one. One retry per failed message (unique index), so a
   * duplicate attempt throws RetryExistsError instead of queueing twice.
   */
  retryOf?: { messageId: string; attempt: number; originAt: string };
  /** Hold the queue message back this long (durable pgmq visibility delay). */
  delaySeconds?: number;
  /**
   * The flow step that sends this message (`flowStepKey()` in lib/flow-engine/types.ts: run id and step seq).
   * messages.flow_step_key is unique, so a replayed step (crash between "queued" and "step recorded") gets the message it
   * already queued back instead of a copy.
   */
  flowStepKey?: string;
  /** Why the message was queued (payload.context); see OutboundContext. */
  context?: OutboundContext;
};

/** The failed message already has its retry (another worker or listener queued it first). */
export class RetryExistsError extends Error {}

/** Inserts a queued message row and pushes it to the outbound queue. */
export async function queueOutbound(
  admin: AdminClient,
  input: QueueOutboundInput,
): Promise<Tables<"messages">> {
  const spec = sendSpecSchema.parse(input.spec);
  const kind = kindForSpec(spec);
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = { send: spec };
  if (input.retryOf)
    payload.retry = { attempt: input.retryOf.attempt, origin_at: input.retryOf.originAt };
  if (input.context) payload.context = input.context;
  const { data: message, error } = await admin
    .from("messages")
    .insert({
      org_id: input.orgId,
      conversation_id: input.conversationId,
      direction: "out",
      kind,
      body: input.body,
      payload: payload as unknown as NonNullable<Json>,
      retry_of_message_id: input.retryOf?.messageId ?? null,
      flow_step_key: input.flowStepKey ?? null,
      media_path: spec.type === "media" ? spec.media_path : null,
      media_mime: spec.type === "media" ? spec.mime_type : null,
      media_filename: spec.type === "media" ? (spec.filename ?? null) : null,
      reply_to_wa_message_id: input.replyToWaMessageId ?? null,
      status: "queued",
      sent_by_user_id: input.sentByUserId,
      flow_run_id: input.flowRunId ?? null,
      campaign_recipient_id: input.campaignRecipientId ?? null,
      at: now,
    })
    .select("*")
    .single();
  const queue = input.priority === false ? "outbound" : "outbound_priority";
  if (error) {
    if (input.retryOf && error.code === "23505") throw new RetryExistsError("retry already queued");
    if (input.flowStepKey && error.code === "23505") {
      const existing = await flowStepMessage(admin, input.orgId, input.flowStepKey);
      if (existing) {
        await requeueIfLost(admin, existing, queue);
        return existing;
      }
    }
    throw new Error(`queueOutbound: ${error.message}`);
  }

  if (spec.type !== "reaction") {
    await admin
      .from("conversations")
      .update({
        last_message_at: now,
        last_message_preview: previewFor(
          kind,
          input.body,
          spec.type === "media" ? (spec.filename ?? null) : null,
        ),
        last_message_direction: "out",
      })
      .eq("id", input.conversationId);
  }

  if (input.delaySeconds)
    await enqueue(queue, { message_id: message.id }, { delaySeconds: input.delaySeconds });
  else await enqueue(queue, { message_id: message.id });
  return message;
}

/** The message a flow step already queued (messages.flow_step_key), or null. */
async function flowStepMessage(
  admin: AdminClient,
  orgId: string,
  key: string,
): Promise<Tables<"messages"> | null> {
  const { data, error } = await admin
    .from("messages")
    .select("*")
    .eq("org_id", orgId)
    .eq("flow_step_key", key)
    .maybeSingle();
  if (error) throw new Error(`queueOutbound: ${error.message}`);
  return data;
}

/**
 * A replayed flow step found its message. If the first attempt stopped between the insert and the enqueue, the row is still
 * 'queued' with no outbound job: requeue_lost_flow_message claims it (once, on the locked row) and queues it in the same
 * transaction. A row that is waiting in a queue, sending, sent, failed or already re-queued is left alone, so a message is
 * never queued twice.
 */
async function requeueIfLost(
  admin: AdminClient,
  message: Tables<"messages">,
  queue: "outbound" | "outbound_priority",
): Promise<void> {
  if (message.status !== "queued" || message.wa_message_id) return;
  const { error } = await admin.rpc("requeue_lost_flow_message", {
    p_message_id: message.id,
    p_queue: queue,
  });
  if (error) throw new Error(`queueOutbound: ${error.message}`);
}

/** Internal note (Comment): stored, never sent. Mentions are created by the caller. */
export async function addNote(
  admin: AdminClient,
  input: { orgId: string; conversationId: string; body: string; userId: string | null },
): Promise<Tables<"messages">> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("messages")
    .insert({
      org_id: input.orgId,
      conversation_id: input.conversationId,
      direction: "note",
      kind: "note",
      body: input.body,
      status: "received",
      sent_by_user_id: input.userId,
      at: now,
    })
    .select("*")
    .single();
  if (error) throw new Error(`addNote: ${error.message}`);
  await admin
    .from("conversations")
    .update({
      last_message_at: now,
      last_message_preview: previewFor("note", input.body),
      last_message_direction: "note",
    })
    .eq("id", input.conversationId);
  return data;
}
