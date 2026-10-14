"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { channelTypeOf, hasWhatsAppFeatures, replyWindow } from "@/lib/channels/types";
import { takeOverFromBot } from "@/lib/flow-engine/takeover";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { buildContactCard } from "@/lib/inbox/contact-card";
import {
  FORWARD_ERRORS,
  buildProductMessage,
  extrasWindowClosedMessage,
  planForward,
} from "@/lib/inbox/extras";
import { isMediaPathFor } from "@/lib/inbox/media-path";
import { queueOutbound, type SendSpec } from "@/lib/inbox/send";
import { MEDIA_BUCKET, extensionFor } from "@/lib/jobs/handlers/media-fetch";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Inbox extras (Sanoflow parity G11, docs/28_PHASE_20F_INBOX_EXTRAS_NOTES.md): forward a message, share a contact
 * card, send a catalogue product, move a chat to a new contact. Every send goes through queueOutbound, so the
 * outbound job applies the 24-hour window, the per-number rate limit, training mode and the stop rules; the actions
 * also check the window first so staff get a clear sentence instead of a failed message. The audit rows carry ids
 * and counts only, never message text, names or numbers.
 */

export type ExtrasResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

const uuid = z.string().uuid();
const TEXT_ONLY = "Only text messages can be sent on this channel.";
const NO_PERMISSION = "You don't have permission for that.";

/** A conversation the caller may see (RLS through the user client), with its channel and contact. */
async function visibleConversation(member: CurrentMember, conversationId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select(
      "id, org_id, channel_id, contact_id, status, last_inbound_at, ad_referral, opened_at, channels(id, type, status, catalog_id)",
    )
    .eq("id", conversationId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return data;
}

type VisibleConversation = NonNullable<Awaited<ReturnType<typeof visibleConversation>>>;

function windowOf(conversation: VisibleConversation) {
  const type = channelTypeOf(conversation.channels?.type);
  return {
    type,
    open: replyWindow(type, {
      lastInboundAt: conversation.last_inbound_at,
      adOpenedAt: conversation.ad_referral ? conversation.opened_at : null,
    }).open,
  };
}

function refresh() {
  revalidatePath("/inbox");
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

export type ForwardTarget = {
  id: string;
  name: string;
  channel_name: string;
  channel_type: string;
};

const targetsSchema = z.object({
  exclude: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});

/**
 * Conversations a message can be forwarded to: the caller can see them (RLS) and their reply window is open (a
 * forward never falls back to a template). Most recent first, at most 30.
 */
export async function listForwardTargets(
  input: z.input<typeof targetsSchema>,
): Promise<ExtrasResult<ForwardTarget[]>> {
  const member = await requirePerm("inbox.send");
  const parsed = targetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, last_inbound_at, ad_referral, opened_at, contacts(first_name, last_name, wa_profile_name, phone_e164), channels(name, type, status)",
    )
    .eq("org_id", member.orgId)
    .gte("last_inbound_at", since)
    .order("last_inbound_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: "Could not load conversations." };
  const q = parsed.data.q?.toLowerCase() ?? "";
  const out: ForwardTarget[] = [];
  for (const c of data ?? []) {
    if (c.id === parsed.data.exclude || !c.contacts || c.channels?.status !== "active") continue;
    const type = channelTypeOf(c.channels?.type);
    const open = replyWindow(type, {
      lastInboundAt: c.last_inbound_at,
      adOpenedAt: c.ad_referral ? c.opened_at : null,
    }).open;
    if (!open) continue;
    const name = contactDisplayName(c.contacts);
    if (q && !name.toLowerCase().includes(q) && !(c.contacts.phone_e164 ?? "").includes(q))
      continue;
    out.push({ id: c.id, name, channel_name: c.channels?.name ?? "", channel_type: type });
    if (out.length >= 30) break;
  }
  return { ok: true, data: out };
}

const forwardSchema = z.object({ message_id: uuid, target_conversation_id: uuid });

/**
 * Forwards one message to another conversation of the same organisation: text as text, a stored file by copying
 * it into the target conversation's folder and sending it again (the normal media path uploads it to Meta). No
 * template fallback: the target's reply window must be open. Website chat, Instagram and Messenger targets take text
 * only (through the existing non-WhatsApp delivery).
 */
export async function forwardMessage(
  input: z.input<typeof forwardSchema>,
): Promise<ExtrasResult<{ message_id: string }>> {
  const member = await requirePerm("inbox.send");
  const parsed = forwardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  // RLS decides whether the caller can see the source message (through its conversation).
  const { data: source } = await supabase
    .from("messages")
    .select(
      "id, org_id, conversation_id, direction, kind, body, media_path, media_mime, media_filename",
    )
    .eq("id", parsed.data.message_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!source) return { ok: false, error: "Message not found." };
  if (source.conversation_id === parsed.data.target_conversation_id)
    return { ok: false, error: FORWARD_ERRORS.same };
  const target = await visibleConversation(member, parsed.data.target_conversation_id);
  if (!target) return { ok: false, error: "Conversation not found." };
  if (target.channels?.status !== "active")
    return { ok: false, error: "That conversation's number is paused or disconnected." };
  const win = windowOf(target);
  const plan = planForward(source, win.type);
  if (!plan.ok) return { ok: false, error: plan.error };
  if (!win.open) return { ok: false, error: extrasWindowClosedMessage(win.type, "forward") };

  const admin = createAdminClient();
  let spec: SendSpec;
  let body: string | null;
  if (plan.kind === "text") {
    spec = { type: "text", body: plan.body };
    body = plan.body;
  } else {
    // The stored file must sit in the source conversation's own folder; anything else is refused.
    if (!isMediaPathFor(plan.sourcePath, member.orgId, source.conversation_id))
      return { ok: false, error: "That file cannot be forwarded." };
    const path = `${member.orgId}/${target.id}/${randomUUID()}.${extensionFor(plan.mime, plan.filename)}`;
    const { error: copyErr } = await admin.storage.from(MEDIA_BUCKET).copy(plan.sourcePath, path);
    if (copyErr) return { ok: false, error: "Could not prepare the file for forwarding." };
    spec = {
      type: "media",
      media_type: plan.mediaType,
      media_path: path,
      mime_type: plan.mime,
      ...(plan.filename ? { filename: plan.filename } : {}),
      ...(plan.caption ? { caption: plan.caption } : {}),
    };
    body = plan.caption;
  }
  await takeOverFromBot(admin, target.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: target.id,
    spec,
    body,
    sentByUserId: member.userId,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "message.forwarded",
    entity: "message",
    entityId: msg.id,
    diff: {
      source_message_id: source.id,
      from_conversation_id: source.conversation_id,
      to_conversation_id: target.id,
      kind: plan.kind,
    },
  });
  refresh();
  return { ok: true, message: "Message forwarded.", data: { message_id: msg.id } };
}

// ---------------------------------------------------------------------------
// Contact card
// ---------------------------------------------------------------------------

const cardSchema = z.object({
  conversation_id: uuid,
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(4).max(32),
  company: z.string().trim().max(100).optional(),
});

/** Shares a contact card that staff typed (never read from a patient record). WhatsApp only, inside 24 hours. */
export async function sendContactCard(
  input: z.input<typeof cardSchema>,
): Promise<ExtrasResult<{ message_id: string }>> {
  const member = await requirePerm("inbox.send");
  const parsed = cardSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const conversation = await visibleConversation(member, parsed.data.conversation_id);
  if (!conversation) return { ok: false, error: "Conversation not found." };
  const win = windowOf(conversation);
  if (!hasWhatsAppFeatures(win.type)) return { ok: false, error: TEXT_ONLY };
  if (conversation.channels?.status !== "active")
    return { ok: false, error: "This number is paused or disconnected." };
  if (!win.open) return { ok: false, error: extrasWindowClosedMessage(win.type, "card") };
  const built = buildContactCard(parsed.data);
  if (!built.ok) return { ok: false, error: built.error };
  const admin = createAdminClient();
  await takeOverFromBot(admin, conversation.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec: { type: "contacts", contacts: [built.card] },
    body: built.label,
    sentByUserId: member.userId,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "message.contact_card_sent",
    entity: "message",
    entityId: msg.id,
    diff: { conversation_id: conversation.id },
  });
  refresh();
  return { ok: true, message: "Contact card sent.", data: { message_id: msg.id } };
}

// ---------------------------------------------------------------------------
// Catalogue product
// ---------------------------------------------------------------------------

const productSchema = z.object({
  conversation_id: uuid,
  retailer_ids: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  header: z.string().trim().max(60).optional(),
  body: z.string().trim().max(1024).optional(),
  footer: z.string().trim().max(60).optional(),
});

/**
 * Sends one product (`product`) or several (`product_list`) from the number's catalogue (`channels.catalog_id`).
 * Staff type the product IDs; no catalogue API is called. WhatsApp only, inside 24 hours.
 */
export async function sendCatalogProduct(
  input: z.input<typeof productSchema>,
): Promise<ExtrasResult<{ message_id: string }>> {
  const member = await requirePerm("inbox.send");
  const parsed = productSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const conversation = await visibleConversation(member, parsed.data.conversation_id);
  if (!conversation) return { ok: false, error: "Conversation not found." };
  const win = windowOf(conversation);
  if (!hasWhatsAppFeatures(win.type)) return { ok: false, error: TEXT_ONLY };
  if (conversation.channels?.status !== "active")
    return { ok: false, error: "This number is paused or disconnected." };
  if (!win.open) return { ok: false, error: extrasWindowClosedMessage(win.type, "product") };
  const built = buildProductMessage({
    catalogId: conversation.channels?.catalog_id,
    retailerIds: parsed.data.retailer_ids,
    header: parsed.data.header,
    body: parsed.data.body,
    footer: parsed.data.footer,
  });
  if (!built.ok) return { ok: false, error: built.error };
  const admin = createAdminClient();
  await takeOverFromBot(admin, conversation.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec: { type: "interactive", interactive: built.interactive },
    body: built.label,
    sentByUserId: member.userId,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "message.product_sent",
    entity: "message",
    entityId: msg.id,
    diff: { conversation_id: conversation.id, products: parsed.data.retailer_ids.length },
  });
  refresh();
  return { ok: true, message: "Product sent.", data: { message_id: msg.id } };
}

// ---------------------------------------------------------------------------
// Move a chat to a new contact ("unlink")
// ---------------------------------------------------------------------------

const unlinkSchema = z.object({
  conversation_id: uuid,
  first_name: z.string().trim().max(100),
  last_name: z.string().trim().max(100),
  keep_household: z.boolean(),
  relationship: z.enum(["child", "parent", "spouse", "other"]).default("other"),
});

/** Database refusals that are safe to show as they are (fixed sentences from the SQL function and triggers). */
const UNLINK_ERRORS: Array<[RegExp, string]> = [
  [/needs a name/, "Enter a name for the new contact."],
  [/only WhatsApp chats/, "Only WhatsApp chats can be moved to a new contact."],
  [/no WhatsApp number/, "This contact has no WhatsApp number to move."],
  [/family links/, "This contact has family links. Remove them in the contact record first."],
  [/not found/, "Conversation not found."],
];

/**
 * Moves this WhatsApp chat (and the old contact's other live WhatsApp chats, which use the same number) to a NEW
 * contact that takes over the number. Messages follow their conversation, so nothing is lost. Optionally the old
 * contact becomes a family member (dependant) of the new one so appointment messages still reach the shared phone.
 * Needs contacts.manage and inbox.send.
 */
export async function unlinkConversationContact(
  input: z.input<typeof unlinkSchema>,
): Promise<ExtrasResult<{ contact_id: string }>> {
  const member = await requirePerm("contacts.manage");
  if (!can(member, "inbox.send")) return { ok: false, error: NO_PERMISSION };
  const parsed = unlinkSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  if (!d.first_name && !d.last_name)
    return { ok: false, error: "Enter a name for the new contact." };
  const conversation = await visibleConversation(member, d.conversation_id);
  if (!conversation) return { ok: false, error: "Conversation not found." };
  if (channelTypeOf(conversation.channels?.type) !== "whatsapp")
    return { ok: false, error: "Only WhatsApp chats can be moved to a new contact." };

  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("unlink_conversation_contact", {
    p_org_id: member.orgId,
    p_conversation_id: conversation.id,
    p_first_name: d.first_name,
    p_last_name: d.last_name,
    p_keep_household: d.keep_household,
    p_relationship: d.relationship,
    p_user_id: member.userId,
  });
  if (error) {
    const known = UNLINK_ERRORS.find(([re]) => re.test(error.message));
    if (known) return { ok: false, error: known[1] };
    console.error("[inbox] unlink failed", {
      code: error.code,
      error: redactText(error.message, 120),
    });
    return { ok: false, error: "Could not move the chat. Nothing was changed." };
  }
  const result = data as { contact_id: string; old_contact_id: string; conversation_ids: string[] };
  // A bot run on a moved chat was talking to the old contact: stop it (staff can hand back to the bot).
  for (const id of result.conversation_ids ?? []) await takeOverFromBot(admin, id, "Chat moved");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "conversation.contact_unlinked",
    entity: "conversation",
    entityId: conversation.id,
    diff: {
      old_contact_id: result.old_contact_id,
      new_contact_id: result.contact_id,
      conversation_ids: result.conversation_ids ?? [],
      household_link: d.keep_household,
    },
  });
  refresh();
  revalidatePath("/contacts");
  return {
    ok: true,
    message: "Chat moved to the new contact.",
    data: { contact_id: result.contact_id },
  };
}
