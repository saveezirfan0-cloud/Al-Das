import "server-only";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { emit } from "@/lib/events/emit";
import { matchOrCreateContact, rotateBsuid } from "@/lib/inbox/contacts";
import { readInboxSettings } from "@/lib/inbox/settings";
import { enqueue } from "@/lib/jobs/enqueue";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { channelByPhoneNumberId } from "@/lib/whatsapp/channel";
import { mapMetaError } from "@/lib/whatsapp/errors";
import {
  previewFor,
  type AccountUpdateEvent,
  type BusinessUsernameEvent,
  type InboundMessageEvent,
  type PhoneQualityEvent,
  type StatusEvent,
  type TemplateCategoryEvent,
  type TemplateQualityEvent,
  type TemplateStatusEvent,
  type UserIdUpdateEvent,
} from "@/lib/whatsapp/parse";
import { fromWebhookStatus } from "@/lib/whatsapp/status";

export type ConversationRow = Tables<"conversations">;

export type InboundResult =
  | { outcome: "stored"; messageId: string; conversationId: string; opened: boolean }
  | { outcome: "duplicate"; messageId: string }
  | { outcome: "skipped"; reason: string };

/**
 * Inbound message → contact → conversation → message row → routing.
 * Idempotent on wa_message_id (unique index): a redelivered webhook is a no-op.
 */
export async function processInbound(
  admin: AdminClient,
  event: InboundMessageEvent,
  log: JobLogger,
): Promise<InboundResult> {
  const channel = await channelByPhoneNumberId(admin, event.phoneNumberId);
  if (!channel) {
    log.warn("inbound for unknown phone_number_id", { phoneNumberId: event.phoneNumberId });
    return { outcome: "skipped", reason: "unknown channel" };
  }
  if (!event.identity.phoneE164 && !event.identity.bsuid) {
    return { outcome: "skipped", reason: "no sender identity" };
  }

  const { data: existing } = await admin
    .from("messages")
    .select("id")
    .eq("wa_message_id", event.waMessageId)
    .maybeSingle();
  if (existing) return { outcome: "duplicate", messageId: existing.id };

  const orgId = channel.org_id;
  const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  const settings = readInboxSettings(org?.settings);

  const match = await matchOrCreateContact(admin, orgId, event.identity, event.timestamp);
  const contact = match.contact;
  if (match.created) {
    await emit(orgId, "contact.created", { contact_id: contact.id, source: "whatsapp" });
    await addTimelineEvent(admin, {
      orgId,
      contactId: contact.id,
      type: "contact.created",
      actorType: "contact",
      payload: { source: "whatsapp" },
    });
  }

  // Live conversation for this contact on this number, else open one.
  let opened = false;
  let { data: conversation } = await admin
    .from("conversations")
    .select("*")
    .eq("channel_id", channel.id)
    .eq("contact_id", contact.id)
    .neq("status", "closed")
    .maybeSingle();

  if (!conversation) {
    const routing = await routeNewConversation(admin, orgId, settings);
    const { data: created, error } = await admin
      .from("conversations")
      .insert({
        org_id: orgId,
        channel_id: channel.id,
        contact_id: contact.id,
        status: "open",
        assignee_team_id: routing.teamId,
        assignee_user_id: routing.userId,
        ad_referral: (event.referral as Json) ?? null,
        opened_at: event.timestamp.toISOString(),
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") {
        // Raced with another inbound: re-read the live conversation.
        const again = await admin
          .from("conversations")
          .select("*")
          .eq("channel_id", channel.id)
          .eq("contact_id", contact.id)
          .neq("status", "closed")
          .maybeSingle();
        conversation = again.data;
      }
      if (!conversation) throw new Error(`conversation insert failed: ${error.message}`);
    } else {
      conversation = created;
      opened = true;
    }
  }

  const isReaction = event.type === "reaction";
  const preview = previewFor(event.type, event.body, event.media?.filename ?? null);
  const { data: message, error: msgErr } = await admin
    .from("messages")
    .insert({
      org_id: orgId,
      conversation_id: conversation.id,
      direction: "in",
      kind: event.type,
      body: event.body,
      payload: event.raw as unknown as NonNullable<Json>,
      media_meta_id: event.media?.metaId ?? null,
      media_mime: event.media?.mimeType ?? null,
      media_filename: event.media?.filename ?? null,
      wa_message_id: event.waMessageId,
      reply_to_wa_message_id: isReaction
        ? (event.reaction?.messageId ?? null)
        : event.replyToWaMessageId,
      status: "received",
      at: event.timestamp.toISOString(),
    })
    .select("id")
    .single();
  if (msgErr) {
    if (msgErr.code === "23505") {
      const dup = await admin
        .from("messages")
        .select("id")
        .eq("wa_message_id", event.waMessageId)
        .single();
      return { outcome: "duplicate", messageId: dup.data?.id ?? "" };
    }
    throw new Error(`message insert failed: ${msgErr.message}`);
  }

  const patch: Partial<ConversationRow> = {
    last_inbound_at: event.timestamp.toISOString(),
    last_message_at: event.timestamp.toISOString(),
    last_message_preview: preview,
    last_message_direction: "in",
    status: "open",
    closed_at: null,
    closed_by: null,
  };
  if (!isReaction) patch.unread_count = conversation.unread_count + 1;
  // Only move the pointer forward (a late/out-of-order delivery must not rewind it).
  if (conversation.last_message_at && new Date(conversation.last_message_at) > event.timestamp) {
    delete patch.last_message_at;
    delete patch.last_message_preview;
    delete patch.last_message_direction;
  }
  await admin.from("conversations").update(patch).eq("id", conversation.id);

  if (event.media) {
    await enqueue("media_fetch", { message_id: message.id });
  }

  if (opened) {
    await addTimelineEvent(admin, {
      orgId,
      contactId: contact.id,
      type: "conversation.opened",
      actorType: "contact",
      payload: { conversation_id: conversation.id, channel_id: channel.id, ad: !!event.referral },
    });
    await emit(orgId, "conversation.opened", {
      conversation_id: conversation.id,
      contact_id: contact.id,
      channel_id: channel.id,
      ad_referral: event.referral,
    });
  }
  await emit(orgId, "message.received", {
    conversation_id: conversation.id,
    message_id: message.id,
    contact_id: contact.id,
    kind: event.type,
  });

  return { outcome: "stored", messageId: message.id, conversationId: conversation.id, opened };
}

/** Default team + round-robin for a freshly opened conversation. */
export async function routeNewConversation(
  admin: AdminClient,
  orgId: string,
  settings: ReturnType<typeof readInboxSettings>,
): Promise<{ teamId: string | null; userId: string | null }> {
  if (!settings.default_team_id) return { teamId: null, userId: null };
  const { data: team } = await admin
    .from("teams")
    .select("id, round_robin")
    .eq("id", settings.default_team_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!team) return { teamId: null, userId: null };
  let userId: string | null = null;
  if (settings.auto_assign === "round_robin" && team.round_robin) {
    const { data } = await admin.rpc("pick_round_robin_assignee", {
      p_org_id: orgId,
      p_team_id: team.id,
    });
    userId = (data as string | null) ?? null;
  }
  return { teamId: team.id, userId };
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export async function processStatus(
  admin: AdminClient,
  event: StatusEvent,
  log: JobLogger,
): Promise<"applied" | "ignored" | "unknown_message"> {
  const status = fromWebhookStatus(event.status);
  if (!status) return "ignored";

  const mapped =
    status === "failed" ? mapMetaError(event.errorCode, event.errorMessage ?? undefined) : null;
  const { data: changed, error } = await admin.rpc("apply_message_status", {
    p_wa_message_id: event.waMessageId,
    p_status: status,
    p_at: event.timestamp.toISOString(),
    p_error_code: event.errorCode ?? undefined,
    p_error_message: mapped
      ? `${mapped.message}${event.errorMessage ? ` — ${event.errorMessage}` : ""}`
      : undefined,
  });
  if (error) throw new Error(`apply_message_status: ${error.message}`);

  const { data: message } = await admin
    .from("messages")
    .select("id, org_id, conversation_id, conversations(contact_id)")
    .eq("wa_message_id", event.waMessageId)
    .maybeSingle();
  if (!message) {
    // Campaign/test sends from elsewhere or a message we never stored.
    log.info("status for unknown message", { status });
    return "unknown_message";
  }

  if (status === "failed" && mapped) {
    const contactId = message.conversations?.contact_id;
    if (mapped.stopMarketing && contactId) {
      await admin.from("contacts").update({ stop_marketing: true }).eq("id", contactId);
      await emit(message.org_id, "contact.stop_marketing", {
        contact_id: contactId,
        code: mapped.code,
      });
    }
    await emit(message.org_id, "message.failed", {
      message_id: message.id,
      conversation_id: message.conversation_id,
      code: mapped.code,
      category: mapped.category,
    });
  }
  return changed ? "applied" : "ignored";
}

// ---------------------------------------------------------------------------
// Template / phone / account / BSUID updates
// ---------------------------------------------------------------------------

const TEMPLATE_EVENT_STATUS: Record<string, string> = {
  APPROVED: "APPROVED",
  REINSTATED: "APPROVED",
  REJECTED: "REJECTED",
  PENDING: "PENDING",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  IN_APPEAL: "IN_APPEAL",
  FLAGGED: "FLAGGED",
  PENDING_DELETION: "PENDING_DELETION",
  DELETED: "DELETED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
};

async function findTemplateIds(
  admin: AdminClient,
  e: { wabaId: string; templateId: string; name: string; language: string },
): Promise<Array<{ id: string; org_id: string }>> {
  const byId = await admin
    .from("wa_templates")
    .select("id, org_id")
    .eq("meta_template_id", e.templateId);
  if (byId.data && byId.data.length) return byId.data;
  const byName = await admin
    .from("wa_templates")
    .select("id, org_id")
    .eq("waba_id", e.wabaId)
    .eq("name", e.name)
    .eq("language", e.language);
  return byName.data ?? [];
}

export async function processTemplateStatus(
  admin: AdminClient,
  e: TemplateStatusEvent,
): Promise<number> {
  const rows = await findTemplateIds(admin, e);
  const status = TEMPLATE_EVENT_STATUS[e.event] ?? e.event;
  for (const r of rows) {
    await admin
      .from("wa_templates")
      .update({
        status,
        meta_template_id: e.templateId,
        rejected_reason: status === "REJECTED" ? (e.reason ?? null) : null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    await emit(r.org_id, "template.status_changed", {
      template_id: r.id,
      status,
      reason: e.reason,
    });
  }
  return rows.length;
}

export async function processTemplateCategory(
  admin: AdminClient,
  e: TemplateCategoryEvent,
): Promise<number> {
  const rows = await findTemplateIds(admin, e);
  for (const r of rows) {
    await admin
      .from("wa_templates")
      .update({ category: e.newCategory, meta_template_id: e.templateId })
      .eq("id", r.id);
  }
  return rows.length;
}

export async function processTemplateQuality(
  admin: AdminClient,
  e: TemplateQualityEvent,
): Promise<number> {
  const rows = await findTemplateIds(admin, e);
  for (const r of rows) {
    await admin
      .from("wa_templates")
      .update({ quality: e.newQuality, meta_template_id: e.templateId })
      .eq("id", r.id);
  }
  return rows.length;
}

function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

export async function processPhoneQuality(
  admin: AdminClient,
  e: PhoneQualityEvent,
): Promise<number> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, org_id, display_phone, meta")
    .eq("waba_id", e.wabaId);
  const target = (channels ?? []).filter(
    (c) => digits(c.display_phone) === digits(e.displayPhoneNumber),
  );
  for (const c of target) {
    const meta = {
      ...((c.meta as Record<string, unknown>) ?? {}),
      last_quality_event: e.raw,
      last_quality_event_at: new Date().toISOString(),
    };
    await admin
      .from("channels")
      .update({
        messaging_limit_tier: e.currentLimit ?? undefined,
        quality_rating:
          e.event === "FLAGGED" ? "RED" : e.event === "UNFLAGGED" ? "GREEN" : undefined,
        meta: meta as NonNullable<Json>,
      })
      .eq("id", c.id);
    await emit(c.org_id, "channel.quality_changed", {
      channel_id: c.id,
      event: e.event,
      limit: e.currentLimit,
    });
  }
  return target.length;
}

export async function processAccountUpdate(
  admin: AdminClient,
  e: AccountUpdateEvent,
): Promise<number> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, meta")
    .eq("waba_id", e.wabaId);
  for (const c of channels ?? []) {
    const meta = {
      ...((c.meta as Record<string, unknown>) ?? {}),
      last_account_update: e.raw,
      last_account_update_at: new Date().toISOString(),
    };
    await admin
      .from("channels")
      .update({ meta: meta as NonNullable<Json> })
      .eq("id", c.id);
  }
  return channels?.length ?? 0;
}

export async function processUserIdUpdate(
  admin: AdminClient,
  e: UserIdUpdateEvent,
): Promise<number> {
  let orgIds: string[] = [];
  if (e.phoneNumberId) {
    const ch = await channelByPhoneNumberId(admin, e.phoneNumberId);
    if (ch) orgIds = [ch.org_id];
  }
  if (orgIds.length === 0) {
    const { data } = await admin.from("channels").select("org_id").eq("waba_id", e.wabaId);
    orgIds = [...new Set((data ?? []).map((c) => c.org_id))];
  }
  let n = 0;
  for (const orgId of orgIds)
    n += await rotateBsuid(admin, orgId, e.oldBsuid, e.newBsuid, e.phoneE164);
  return n;
}

export async function processBusinessUsername(
  admin: AdminClient,
  e: BusinessUsernameEvent,
): Promise<number> {
  const q = e.phoneNumberId
    ? admin.from("channels").select("id, meta").eq("phone_number_id", e.phoneNumberId)
    : admin.from("channels").select("id, meta").eq("waba_id", e.wabaId);
  const { data: channels } = await q;
  for (const c of channels ?? []) {
    const meta = {
      ...((c.meta as Record<string, unknown>) ?? {}),
      username: e.username,
      username_event: e.event,
    };
    await admin
      .from("channels")
      .update({ meta: meta as NonNullable<Json> })
      .eq("id", c.id);
  }
  return channels?.length ?? 0;
}
