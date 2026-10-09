import { z } from "zod";

import { emit } from "@/lib/events/emit";
import { sendSpecSchema, type SendSpec } from "@/lib/inbox/send";
import { readInboxSettings } from "@/lib/inbox/settings";
import { enqueue } from "@/lib/jobs/enqueue";
import { registerHandler } from "@/lib/jobs/registry";
import {
  bulkSlotCap,
  MAX_SLOT_WAIT_MS,
  slotRetryDelaySeconds,
  slotWaitExpired,
} from "@/lib/jobs/pacing";
import { PermanentJobError, type JobContext } from "@/lib/jobs/types";
import type { QueueName } from "@/lib/jobs/queues";
import type { AdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/jobs/handlers/media-fetch";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError, mapMetaError } from "@/lib/whatsapp/errors";
import { e164ToWaId } from "@/lib/whatsapp/phone";
import { buildTemplateSend, isMarketingBlocked, isTemplateSendable } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent, SendResult } from "@/lib/whatsapp/types";
import { serviceWindow } from "@/lib/whatsapp/window";

/**
 * `outbound` / `outbound_priority` queues: { message_id }.
 * Guards, in order: row still queued → recipient known → 24h window (templates exempt)
 * → per-number send slot (re-queued 1s later when saturated) → send → status.
 * Meta errors go through the error map: retryable ones re-queue via the visibility
 * timeout, the rest mark the message failed (131050 also sets stop_marketing).
 */
const job = z.object({
  message_id: z.string().uuid(),
  attempt: z.number().int().optional(),
});

const WINDOW_CLOSED_CODE = 131047;

export async function deliverOutbound(
  admin: AdminClient,
  messageId: string,
  ctx: JobContext,
  attempt = 0,
): Promise<void> {
  const { log } = ctx;
  const { data: message } = await admin
    .from("messages")
    .select(
      "id, org_id, conversation_id, at, status, wa_message_id, payload, body, sent_by_user_id, reply_to_wa_message_id, media_meta_id, media_filename, conversations(id, status, last_inbound_at, ad_referral, opened_at, channel_id, contact_id, contacts(id, phone_e164, wa_bsuid, stop_marketing), channels(id, org_id, status, phone_number_id, waba_id, send_rate_per_sec))",
    )
    .eq("id", messageId)
    .maybeSingle();
  if (!message) throw new PermanentJobError("message not found");
  if (message.wa_message_id || !["queued", "sending"].includes(message.status)) return; // done or failed elsewhere

  const conversation = message.conversations;
  const contact = conversation?.contacts;
  const channel = conversation?.channels;
  if (!conversation || !contact || !channel)
    throw new PermanentJobError("message is missing its conversation, contact or channel");

  const specParsed = sendSpecSchema.safeParse((message.payload as { send?: unknown } | null)?.send);
  if (!specParsed.success) {
    await markFailed(admin, message.id, -1, "Malformed send payload.");
    return;
  }
  const spec = specParsed.data;

  if (channel.status !== "active") {
    await markFailed(admin, message.id, -1, "The WhatsApp number is paused or disconnected.");
    return;
  }

  const to = contact.phone_e164 ? e164ToWaId(contact.phone_e164) : contact.wa_bsuid;
  if (!to) {
    await markFailed(admin, message.id, -1, "The contact has no WhatsApp phone or user id.");
    return;
  }

  if (spec.type !== "template") {
    const w = serviceWindow({
      lastInboundAt: conversation.last_inbound_at,
      adOpenedAt: conversation.ad_referral ? conversation.opened_at : null,
    });
    if (!w.open) {
      await markFailed(
        admin,
        message.id,
        WINDOW_CLOSED_CODE,
        mapMetaError(WINDOW_CLOSED_CODE).message,
      );
      await emit(message.org_id, "message.failed", {
        message_id: message.id,
        conversation_id: conversation.id,
        code: WINDOW_CLOSED_CODE,
        category: "recipient",
      });
      return;
    }
  }

  // Per-number rate limit (atomic in SQL), enforced at send time on every pass. Live chat retries
  // next second; bulk sends (the `outbound` lane) use at most BULK_SHARE of the limit and, when the
  // current second is full, book a future second once instead of polling (reserve_send_slot). A
  // booked message that runs late just fails the claim again and is re-booked, so catching up
  // after a stall can never burst past the limit.
  const bulk = ctx.queue === "outbound";
  const cap = bulk ? bulkSlotCap(channel.send_rate_per_sec) : channel.send_rate_per_sec;
  const { data: slot, error: slotErr } = await admin.rpc("claim_send_slot", {
    p_channel_id: channel.id,
    p_limit: cap,
  });
  if (slotErr) throw new Error(`claim_send_slot: ${slotErr.message}`);
  if (!slot) {
    if (slotWaitExpired(message.at)) {
      await markFailed(
        admin,
        message.id,
        -1,
        "The send queue was too long; not sent. Please resend.",
      );
      return;
    }
    if (bulk) {
      const { data: wait, error: reserveErr } = await admin.rpc("reserve_send_slot", {
        p_channel_id: channel.id,
        p_cap: cap,
      });
      if (reserveErr) throw new Error(`reserve_send_slot: ${reserveErr.message}`);
      const delay = Number(wait);
      if (delay * 1000 > MAX_SLOT_WAIT_MS) {
        await markFailed(
          admin,
          message.id,
          -1,
          "The send queue was too long; not sent. Please resend.",
        );
        return;
      }
      await enqueue(
        ctx.queue as QueueName,
        { message_id: message.id, attempt: attempt + 1 },
        { delaySeconds: delay },
      );
      log.info("send slot booked", { messageId: message.id, delaySeconds: delay });
      return;
    }
    await enqueue(
      ctx.queue as QueueName,
      { message_id: message.id, attempt: attempt + 1 },
      { delaySeconds: slotRetryDelaySeconds(attempt) },
    );
    log.info("send slot saturated; re-queued", { messageId: message.id, attempt });
    return;
  }

  await admin.from("messages").update({ status: "sending" }).eq("id", message.id);

  const client = await clientForChannel(admin, channel);
  const replyTo = message.reply_to_wa_message_id
    ? { replyTo: message.reply_to_wa_message_id }
    : undefined;

  try {
    let result: SendResult;
    switch (spec.type) {
      case "text": {
        const body = await decorateBody(admin, message.org_id, message.sent_by_user_id, spec.body);
        result = await client.sendText(to, body, { ...replyTo, previewUrl: spec.preview_url });
        break;
      }
      case "media": {
        let mediaId = message.media_meta_id;
        if (!mediaId) {
          const { data: blob, error } = await admin.storage
            .from(MEDIA_BUCKET)
            .download(spec.media_path);
          if (error || !blob)
            throw new PermanentJobError(
              `attachment missing in storage: ${error?.message ?? "no data"}`,
            );
          const up = await client.uploadMedia({
            data: blob,
            mimeType: spec.mime_type,
            filename: spec.filename ?? message.media_filename ?? undefined,
          });
          mediaId = up.id;
          await admin.from("messages").update({ media_meta_id: mediaId }).eq("id", message.id);
        }
        const caption = spec.caption
          ? await decorateBody(admin, message.org_id, message.sent_by_user_id, spec.caption)
          : undefined;
        result = await client.sendMedia(
          to,
          spec.media_type,
          { id: mediaId, caption, filename: spec.filename },
          replyTo,
        );
        break;
      }
      case "template": {
        const { data: tpl } = await admin
          .from("wa_templates")
          .select("name, language, components, status, parameter_format, category")
          .eq("id", spec.template_id)
          .eq("org_id", message.org_id)
          .maybeSingle();
        if (!tpl) throw new PermanentJobError("template not found");
        if (!isTemplateSendable(tpl.status)) {
          await markFailed(
            admin,
            message.id,
            132001,
            `Template "${tpl.name}" is ${tpl.status}, not APPROVED.`,
          );
          return;
        }
        // Opt-outs can arrive between queueing and sending (CLAUDE.md rule 11): check again now.
        if (isMarketingBlocked(tpl.category, contact.stop_marketing)) {
          await markFailed(admin, message.id, 131050, "The recipient opted out of marketing messages.");
          await emit(message.org_id, "message.failed", {
            message_id: message.id,
            conversation_id: conversation.id,
            code: 131050,
            category: "recipient",
          });
          return;
        }
        const template = buildTemplateSend(
          {
            name: tpl.name,
            language: tpl.language,
            components: tpl.components as unknown as MetaTemplateComponent[],
            parameterFormat: tpl.parameter_format as "positional" | "named",
          },
          spec.values,
        );
        result = await client.sendTemplate(to, template, replyTo);
        break;
      }
      case "interactive":
        result = await client.sendInteractive(to, spec.interactive, replyTo);
        break;
      case "reaction":
        result = await client.sendReaction(to, spec.wa_message_id, spec.emoji);
        break;
      case "location":
        result = await client.sendLocation(
          to,
          {
            latitude: spec.latitude,
            longitude: spec.longitude,
            name: spec.name,
            address: spec.address,
          },
          replyTo,
        );
        break;
    }

    const waId = result.messages?.[0]?.id;
    if (!waId) throw new Error("Meta accepted the message without an id");
    const now = new Date().toISOString();
    await admin
      .from("messages")
      .update({ wa_message_id: waId, status: "sent", error_code: null, error_message: null })
      .eq("id", message.id);

    const convPatch: { last_outbound_at: string; status?: "waiting" } = { last_outbound_at: now };
    if (message.sent_by_user_id && spec.type !== "reaction") {
      const { data: org } = await admin
        .from("orgs")
        .select("settings")
        .eq("id", message.org_id)
        .single();
      if (readInboxSettings(org?.settings).waiting_on_reply && conversation.status === "open")
        convPatch.status = "waiting";
    }
    await admin.from("conversations").update(convPatch).eq("id", conversation.id);
    await emit(message.org_id, "message.sent", {
      message_id: message.id,
      conversation_id: conversation.id,
      kind: spec.type,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      const m = err.mapped;
      if (m.retryable && ctx.readCt < 5) {
        await admin
          .from("messages")
          .update({
            status: "queued",
            error_code: err.code,
            error_message: `${m.message} (retrying)`,
          })
          .eq("id", message.id);
        throw err; // visibility timeout → retry
      }
      await markFailed(
        admin,
        message.id,
        err.code,
        m.message + (err.details ? ` — ${err.details}` : ""),
      );
      if (m.stopMarketing) {
        await admin.from("contacts").update({ stop_marketing: true }).eq("id", contact.id);
        await emit(message.org_id, "contact.stop_marketing", {
          contact_id: contact.id,
          code: err.code,
        });
      }
      await emit(message.org_id, "message.failed", {
        message_id: message.id,
        conversation_id: conversation.id,
        code: err.code,
        category: m.category,
      });
      log.warn("send failed", { messageId: message.id, code: err.code, category: m.category });
      return;
    }
    if (err instanceof PermanentJobError || ctx.readCt >= 5) {
      await markFailed(admin, message.id, -1, err instanceof Error ? err.message : String(err));
      return;
    }
    await admin.from("messages").update({ status: "queued" }).eq("id", message.id);
    throw err;
  }
}

async function markFailed(
  admin: AdminClient,
  messageId: string,
  code: number,
  text: string,
): Promise<void> {
  await admin
    .from("messages")
    .update({ status: "failed", error_code: code, error_message: text.slice(0, 500) })
    .eq("id", messageId);
}

/** "Show agent name in messages": prefix the first name in bold. */
async function decorateBody(
  admin: AdminClient,
  orgId: string,
  userId: string | null,
  body: string,
): Promise<string> {
  if (!userId) return body;
  const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  if (!readInboxSettings(org?.settings).show_agent_name) return body;
  const { data: profile } = await admin
    .from("profiles")
    .select("first_name")
    .eq("id", userId)
    .maybeSingle();
  const name = profile?.first_name?.trim();
  return name ? `*${name}:*\n${body}` : body;
}

for (const queue of ["outbound_priority", "outbound"] as const) {
  registerHandler({
    queue,
    name: `${queue}.send`,
    batchSize: queue === "outbound_priority" ? 25 : 100,
    visibilityTimeout: 60,
    maxReads: 5,
    concurrency: "parallel",
    async handler(raw, ctx) {
      const parsed = job.safeParse(raw);
      if (!parsed.success) throw new PermanentJobError("invalid outbound job payload");
      await deliverOutbound(ctx.admin, parsed.data.message_id, ctx, parsed.data.attempt ?? 0);
    },
  });
}

export type { SendSpec };
