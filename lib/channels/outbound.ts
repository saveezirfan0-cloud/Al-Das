import "server-only";

import { loadAccount } from "@/lib/integrations/accounts";
import { buildMessagingClientFor } from "@/lib/integrations/meta-messaging/server";
import { sendFailureText } from "@/lib/integrations/meta-messaging/client";
import type { SendSpec } from "@/lib/inbox/send";
import type { JobContext } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";

import { channelTypeOf, isSocialPlatform, replyWindow, windowClosedMessage } from "./types";

/** Error code stored on a message refused because the Instagram / Messenger window has closed. */
export const SOCIAL_WINDOW_CLOSED_CODE = 2018278;

/** A throttled send the queue should try again (the job is re-delivered after its visibility timeout). */
export class ChannelRetryError extends Error {
  constructor() {
    super("channel send throttled; retrying");
    this.name = "ChannelRetryError";
  }
}

export type ChannelOutboundInput = {
  message: { id: string; org_id: string };
  conversation: { id: string; last_inbound_at: string | null };
  contactId: string;
  channel: { id: string; type: string; status: string };
  spec: SendSpec;
};

async function markFailed(admin: AdminClient, id: string, code: number, text: string) {
  await admin
    .from("messages")
    .update({ status: "failed", error_code: code, error_message: text.slice(0, 500) })
    .eq("id", id)
    .in("status", ["queued", "sending"]);
}

async function markSent(admin: AdminClient, a: ChannelOutboundInput, externalId: string) {
  await admin
    .from("messages")
    .update({ wa_message_id: externalId, status: "sent", error_code: null, error_message: null })
    .eq("id", a.message.id);
  await admin
    .from("conversations")
    .update({ last_outbound_at: new Date().toISOString() })
    .eq("id", a.conversation.id);
}

/**
 * Delivers a queued outbound message on a website chat, Instagram or Messenger conversation (called by the outbound queue
 * handler for every channel that is not WhatsApp; the WhatsApp path is untouched). Text only.
 *
 *   web        nothing leaves Pulse: the message is marked sent and the visitor's widget fetches it (and marks it delivered)
 *   instagram  sent through the Send API with the Page token, only inside Meta's 24-hour window, to the platform-scoped id
 *   messenger  stored for this contact on this channel; refused outside the window with a clear error, never retried after an
 *              answer that might mean it was delivered
 */
export async function deliverChannelOutbound(
  admin: AdminClient,
  a: ChannelOutboundInput,
  ctx: Pick<JobContext, "log" | "readCt">,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<void> {
  const type = channelTypeOf(a.channel.type);
  if (type === "whatsapp") throw new Error("deliverChannelOutbound called for a WhatsApp channel");
  if (a.spec.type !== "text") {
    await markFailed(admin, a.message.id, -1, "Only text messages can be sent on this channel.");
    return;
  }
  if (a.channel.status !== "active") {
    await markFailed(admin, a.message.id, -1, "This channel is paused or disconnected.");
    return;
  }

  if (type === "web") {
    const account = await loadAccount(admin, a.message.org_id, "web_chat");
    if (!account?.enabled) {
      await markFailed(admin, a.message.id, -1, "Website chat is switched off.");
      return;
    }
    await markSent(admin, a, `web:${a.message.id}`);
    return;
  }

  if (!isSocialPlatform(type)) return;
  const w = replyWindow(type, { lastInboundAt: a.conversation.last_inbound_at });
  if (!w.open) {
    await markFailed(admin, a.message.id, SOCIAL_WINDOW_CLOSED_CODE, windowClosedMessage(type));
    return;
  }
  const account = await loadAccount(admin, a.message.org_id, type);
  if (!account?.enabled) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      `The ${type === "instagram" ? "Instagram" : "Messenger"} integration is switched off.`,
    );
    return;
  }
  const { data: identity } = await admin
    .from("contact_channel_identities")
    .select("external_id")
    .eq("org_id", a.message.org_id)
    .eq("channel_id", a.channel.id)
    .eq("contact_id", a.contactId)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!identity) {
    await markFailed(admin, a.message.id, -1, "This person has no account id on this channel.");
    return;
  }
  const client = buildMessagingClientFor(admin, account, type, deps.fetchFn);
  if (!client) {
    await markFailed(admin, a.message.id, -1, "The integration settings are incomplete.");
    return;
  }
  await admin.from("messages").update({ status: "sending" }).eq("id", a.message.id);
  const r = await client.sendText(identity.external_id, a.spec.body);
  if (r.ok) {
    await markSent(admin, a, `${type === "instagram" ? "ig" : "fb"}:${r.messageId}`);
    return;
  }
  if (r.retryable && ctx.readCt < 5) {
    await admin.from("messages").update({ status: "queued" }).eq("id", a.message.id);
    ctx.log.warn("channel send throttled", { messageId: a.message.id, code: r.code });
    throw new ChannelRetryError();
  }
  await markFailed(
    admin,
    a.message.id,
    r.windowClosed ? SOCIAL_WINDOW_CLOSED_CODE : -1,
    sendFailureText(type, r),
  );
  ctx.log.warn("channel send failed", { messageId: a.message.id, code: r.code });
}
