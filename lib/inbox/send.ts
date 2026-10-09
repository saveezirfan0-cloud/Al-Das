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
  }
}

export type QueueOutboundInput = {
  orgId: string;
  conversationId: string;
  spec: SendSpec;
  /** Text shown in the thread / preview (template body text, caption, etc.). */
  body: string | null;
  sentByUserId: string | null;
  replyToWaMessageId?: string | null;
  flowRunId?: string | null;
  /** Extra keys stored beside `send` in the message payload (e.g. flow_step, used to avoid double sends on retry). */
  extraPayload?: Record<string, unknown>;
  campaignRecipientId?: string | null;
  /** Live chat → outbound_priority; campaigns/automations → outbound. */
  priority?: boolean;
};

/** Inserts a queued message row and pushes it to the outbound queue. */
export async function queueOutbound(
  admin: AdminClient,
  input: QueueOutboundInput,
): Promise<Tables<"messages">> {
  const spec = sendSpecSchema.parse(input.spec);
  const kind = kindForSpec(spec);
  const now = new Date().toISOString();
  const { data: message, error } = await admin
    .from("messages")
    .insert({
      org_id: input.orgId,
      conversation_id: input.conversationId,
      direction: "out",
      kind,
      body: input.body,
      payload: { send: spec, ...(input.extraPayload ?? {}) } as unknown as NonNullable<Json>,
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
  if (error) throw new Error(`queueOutbound: ${error.message}`);

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

  await enqueue(input.priority === false ? "outbound" : "outbound_priority", {
    message_id: message.id,
  });
  return message;
}

/** Internal note (Comment): stored, never sent. Mentions are created by the caller. */
export async function addNote(
  admin: AdminClient,
  input: { orgId: string; conversationId: string; body: string; userId: string },
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
