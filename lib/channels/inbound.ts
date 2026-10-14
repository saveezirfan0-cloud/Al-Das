import "server-only";

import { screenInboundMessage } from "@/lib/ai/intent/server";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { routeConversation, sendTeamAutoReply } from "@/lib/inbox/routing";
import { readInboxSettings } from "@/lib/inbox/settings";
import { notify } from "@/lib/notify/dispatch-db";
import { scheduleFirstEscalation } from "@/lib/notify/escalation-job";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import type { ChannelType } from "./types";

/**
 * What web_chat_receive() / channel_receive_social() return (the SQL functions do contact -> conversation -> message in one
 * transaction). `error` means nothing was stored.
 */
export type ReceiveResult = {
  error?: "channel" | "session";
  duplicate?: boolean;
  message_id?: string;
  conversation_id?: string;
  contact_id?: string;
  session_id?: string;
  opened?: boolean;
  created_contact?: boolean;
  unread_before?: number;
  assignee_user_id?: string | null;
  escalation_level?: number;
};

export function readReceiveResult(data: Json | null): ReceiveResult {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as ReceiveResult) : {};
}

/**
 * Everything the WhatsApp inbound path does after storing a message that also makes sense for the website chat, Instagram and
 * Messenger: route a newly opened conversation (default team, round robin), tell its owner or start the escalation ladder, and
 * screen the text for emergency wording. Domain events (flows, outbound webhooks) are deliberately NOT emitted for these
 * channels in Phase 20e: the flow engine and its nodes are WhatsApp-only. Never throws: the message is already stored.
 */
export async function afterChannelInbound(
  admin: AdminClient,
  a: {
    orgId: string;
    channelType: Exclude<ChannelType, "whatsapp">;
    body: string | null;
    result: ReceiveResult;
  },
): Promise<void> {
  const r = a.result;
  if (!r.conversation_id || !r.message_id || r.duplicate) return;
  try {
    const { data: org } = await admin.from("orgs").select("settings").eq("id", a.orgId).single();
    let ownerId = r.assignee_user_id ?? null;
    if (r.opened) {
      // Phase 20c routing (capacity, fallback team; the owner is written in SQL) and the team auto-reply, as on WhatsApp.
      const routed = await routeConversation(
        admin,
        a.orgId,
        r.conversation_id,
        readInboxSettings(org?.settings),
      );
      if (routed) {
        ownerId = routed.userId ?? ownerId;
        await sendTeamAutoReply(admin, {
          orgId: a.orgId,
          conversationId: r.conversation_id,
          outcome: routed,
          alreadySentAt: null,
          lastInboundAt: new Date(),
        });
      }
      if (r.contact_id)
        await addTimelineEvent(admin, {
          orgId: a.orgId,
          contactId: r.contact_id,
          type: "conversation.opened",
          actorType: "contact",
          payload: { conversation_id: r.conversation_id, channel_type: a.channelType },
        });
    }
    if (ownerId) {
      if ((r.unread_before ?? 0) === 0)
        await notify(admin, {
          orgId: a.orgId,
          userIds: [ownerId],
          event: "inbox.message",
          type: "inbox.message",
          title: "New message",
          body: "A patient replied in a conversation assigned to you.",
          payload: { conversation_id: r.conversation_id },
          ids: { conversation_id: r.conversation_id },
        });
    } else {
      await scheduleFirstEscalation(a.orgId, org?.settings, {
        id: r.conversation_id,
        assignee_user_id: null,
        escalation_level: r.escalation_level ?? 0,
      });
    }
    await screenInboundMessage(admin, {
      orgId: a.orgId,
      orgSettings: org?.settings,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      body: a.body,
    });
  } catch (err) {
    console.error("[channels] after-inbound failed", {
      channel: a.channelType,
      error: redactText(err, 120),
    });
  }
}
