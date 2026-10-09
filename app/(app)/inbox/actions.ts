"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm, type CurrentMember } from "@/lib/auth/session";
import { emit } from "@/lib/events/emit";
import "@/lib/flow-engine/listeners";
import { startRun } from "@/lib/flow-engine/run";
import { createFlowDeps } from "@/lib/flow-engine/supabase-deps";
import { takeOverFromBot } from "@/lib/flow-engine/takeover";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { parseMentions } from "@/lib/inbox/mentions";
import { addNote, queueOutbound, type SendSpec } from "@/lib/inbox/send";
import { readInboxSettings } from "@/lib/inbox/settings";
import { enqueue } from "@/lib/jobs/enqueue";
import { MEDIA_BUCKET, extensionFor } from "@/lib/jobs/handlers/media-fetch";
import { createNotification } from "@/lib/notifications";
import { isMediaPathFor, parseMediaPath } from "@/lib/inbox/media-path";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { toE164 } from "@/lib/whatsapp/phone";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

const uuid = z.string().uuid();

/** Loads a conversation the caller may see (RLS through the user client) and asserts the permission. */
async function visibleConversation(
  member: CurrentMember,
  conversationId: string,
  perm = "inbox.send",
) {
  if (!can(member, perm))
    return { error: "You don't have permission for that." as const, conversation: null };
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("*, contacts(*), channels(id, name, phone_number_id, waba_id, status)")
    .eq("id", conversationId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!data) return { error: "Conversation not found." as const, conversation: null };
  return { error: null, conversation: data };
}

function refresh() {
  revalidatePath("/inbox");
}

/** Replaces {contact.first_name} style variables in quick replies / free text. */
function fillVars(
  text: string,
  contact: { first_name: string; last_name: string; phone_e164: string | null } | null,
  agent: CurrentMember,
) {
  const map: Record<string, string> = {
    "contact.first_name": contact?.first_name ?? "",
    "contact.last_name": contact?.last_name ?? "",
    "contact.name": contact ? `${contact.first_name} ${contact.last_name}`.trim() : "",
    "contact.phone": contact?.phone_e164 ?? "",
    "agent.first_name": agent.profile.first_name,
    "agent.name": `${agent.profile.first_name} ${agent.profile.last_name}`.trim(),
    "org.name": agent.org.name,
  };
  return text.replace(/\{([a-z_.]+)\}/g, (m, key: string) => (key in map ? map[key] : m));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const chatSchema = z.object({
  conversation_id: uuid,
  text: z.string().trim().min(1).max(4096),
  reply_to: z.string().max(200).nullish(),
});

export async function sendChat(
  input: z.input<typeof chatSchema>,
): Promise<ActionResult<{ message_id: string }>> {
  const member = await requireMember();
  const parsed = chatSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  if (conversation.channels?.status !== "active")
    return { ok: false, error: "This number is paused or disconnected." };
  const body = fillVars(parsed.data.text, conversation.contacts, member);
  const admin = createAdminClient();
  await takeOverFromBot(admin, conversation.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec: { type: "text", body },
    body,
    sentByUserId: member.userId,
    replyToWaMessageId: parsed.data.reply_to ?? null,
  });
  refresh();
  return { ok: true, data: { message_id: msg.id } };
}

const uploadSchema = z.object({
  conversation_id: uuid,
  filename: z.string().trim().min(1).max(200),
  mime_type: z.string().trim().min(1).max(100),
  size: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
});

/** Signed upload URL so the browser uploads straight to Storage (no Vercel body limit). */
export async function createAttachmentUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string; signed_url: string }>> {
  const member = await requireMember();
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  const ext = extensionFor(parsed.data.mime_type, parsed.data.filename);
  const path = `${member.orgId}/${conversation.id}/${randomUUID()}.${ext}`;
  const { data, error: upErr } = await admin.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (upErr || !data)
    return { ok: false, error: `Could not prepare the upload: ${upErr?.message ?? "unknown"}` };
  return { ok: true, data: { path: data.path, token: data.token, signed_url: data.signedUrl } };
}

const attachmentSchema = z.object({
  conversation_id: uuid,
  path: z.string().min(1),
  mime_type: z.string().min(1),
  filename: z.string().min(1).max(200),
  media_type: z.enum(["image", "video", "audio", "document", "sticker"]),
  caption: z.string().trim().max(1024).optional(),
});

export async function sendAttachment(
  input: z.input<typeof attachmentSchema>,
): Promise<ActionResult<{ message_id: string }>> {
  const member = await requireMember();
  const parsed = attachmentSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  if (!isMediaPathFor(parsed.data.path, member.orgId, conversation.id))
    return { ok: false, error: "Invalid attachment path." };
  const d = parsed.data;
  const spec: SendSpec = {
    type: "media",
    media_type: d.media_type,
    media_path: d.path,
    mime_type: d.mime_type,
    filename: d.filename,
    caption: d.caption ? fillVars(d.caption, conversation.contacts, member) : undefined,
  };
  const admin = createAdminClient();
  await takeOverFromBot(admin, conversation.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec,
    body: d.caption ?? null,
    sentByUserId: member.userId,
  });
  refresh();
  return { ok: true, data: { message_id: msg.id } };
}

const templateSchema = z.object({
  conversation_id: uuid,
  template_id: uuid,
  values: z.record(z.string(), z.string()).default({}),
});

export async function sendTemplateMessage(
  input: z.input<typeof templateSchema>,
): Promise<ActionResult<{ message_id: string }>> {
  const member = await requireMember();
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  const { data: tpl } = await admin
    .from("wa_templates")
    .select("id, name, status, components, category")
    .eq("id", parsed.data.template_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!tpl) return { ok: false, error: "Template not found." };
  if (tpl.status !== "APPROVED")
    return {
      ok: false,
      error: `Template "${tpl.name}" is ${tpl.status}; only approved templates can be sent.`,
    };
  if (tpl.category === "MARKETING" && conversation.contacts?.stop_marketing)
    return { ok: false, error: "This patient has opted out of marketing messages." };
  const preview = renderTemplatePreview(
    tpl.components as unknown as MetaTemplateComponent[],
    parsed.data.values,
  );
  if (preview.missing.length) return { ok: false, error: `Fill in: ${preview.missing.join(", ")}` };
  await takeOverFromBot(admin, conversation.id);
  const msg = await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec: { type: "template", template_id: tpl.id, values: parsed.data.values },
    body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
    sentByUserId: member.userId,
  });
  refresh();
  return { ok: true, data: { message_id: msg.id } };
}

const commentSchema = z.object({ conversation_id: uuid, text: z.string().trim().min(1).max(4096) });

export async function addComment(
  input: z.input<typeof commentSchema>,
): Promise<ActionResult<{ message_id: string }>> {
  const member = await requireMember();
  const parsed = commentSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const { text, userIds } = parseMentions(parsed.data.text);
  const admin = createAdminClient();
  const note = await addNote(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    body: text,
    userId: member.userId,
  });
  if (userIds.length) {
    const { data: members } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .in("user_id", userIds);
    const valid = (members ?? []).map((m) => m.user_id).filter((id) => id !== member.userId);
    if (valid.length) {
      await admin.from("mentions").insert(
        valid.map((user_id) => ({
          org_id: member.orgId,
          message_id: note.id,
          conversation_id: conversation.id,
          contact_id: conversation.contact_id,
          mentioned_by: member.userId,
          user_id,
        })),
      );
      const who =
        `${member.profile.first_name} ${member.profile.last_name}`.trim() || "A colleague";
      const patient = conversation.contacts
        ? contactDisplayName(conversation.contacts)
        : "a patient";
      for (const user_id of valid) {
        await createNotification(admin, {
          orgId: member.orgId,
          userId: user_id,
          type: "mention",
          title: `${who} mentioned you`,
          body: `In the conversation with ${patient}: ${text.slice(0, 120)}`,
          payload: { conversation_id: conversation.id, message_id: note.id },
        });
      }
    }
  }
  refresh();
  return { ok: true, data: { message_id: note.id } };
}

export async function retryFailedMessage(messageId: string): Promise<ActionResult> {
  const member = await requirePerm("inbox.send");
  const admin = createAdminClient();
  const { data: msg } = await admin
    .from("messages")
    .select("id, status, direction, conversation_id")
    .eq("id", messageId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!msg || msg.direction !== "out") return { ok: false, error: "Message not found." };
  if (msg.status !== "failed") return { ok: false, error: "Only failed messages can be retried." };
  const { error } = await visibleConversation(member, msg.conversation_id);
  if (error) return { ok: false, error };
  await admin
    .from("messages")
    .update({ status: "queued", error_code: null, error_message: null, wa_message_id: null })
    .eq("id", msg.id);
  await enqueue("outbound_priority", { message_id: msg.id });
  refresh();
  revalidatePath("/inbox/failed");
  return { ok: true, message: "Message queued again.", data: undefined };
}

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

export async function markConversationRead(conversationId: string): Promise<ActionResult> {
  const member = await requireMember();
  const { error, conversation } = await visibleConversation(member, conversationId, "inbox.send");
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  if (conversation.unread_count > 0)
    await admin.from("conversations").update({ unread_count: 0 }).eq("id", conversation.id);
  await admin
    .from("mentions")
    .update({ read_at: new Date().toISOString() })
    .eq("conversation_id", conversation.id)
    .eq("user_id", member.userId)
    .is("read_at", null);
  // Blue ticks on WhatsApp: best effort, never blocks the UI.
  const { data: last } = await admin
    .from("messages")
    .select("wa_message_id")
    .eq("conversation_id", conversation.id)
    .eq("direction", "in")
    .not("wa_message_id", "is", null)
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last?.wa_message_id && conversation.channels && conversation.channels.status === "active") {
    try {
      const client = await clientForChannel(admin, conversation.channels);
      await client.markRead(last.wa_message_id);
    } catch (err) {
      console.warn("[inbox] mark-read failed", {
        error: redactText(err),
      });
    }
  }
  return { ok: true, data: undefined };
}

const assignSchema = z.object({
  conversation_id: uuid,
  user_id: uuid.nullable(),
  team_id: uuid.nullable(),
});

export async function assignConversation(
  input: z.input<typeof assignSchema>,
): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  const { error: upErr } = await admin
    .from("conversations")
    .update({
      assignee_user_id: parsed.data.user_id,
      assignee_team_id: parsed.data.team_id,
      bot_active: false,
    })
    .eq("id", conversation.id);
  if (upErr)
    return { ok: false, error: "Could not assign (is the user a member of this workspace?)." };
  await takeOverFromBot(admin, conversation.id);
  if (parsed.data.user_id && parsed.data.user_id !== member.userId) {
    await createNotification(admin, {
      orgId: member.orgId,
      userId: parsed.data.user_id,
      type: "inbox.assigned",
      title: "Conversation assigned to you",
      body: conversation.contacts ? `With ${contactDisplayName(conversation.contacts)}` : null,
      payload: { conversation_id: conversation.id },
    });
  }
  await emit(member.orgId, "conversation.assigned", {
    conversation_id: conversation.id,
    user_id: parsed.data.user_id,
    team_id: parsed.data.team_id,
    by: member.userId,
  });
  refresh();
  return { ok: true, message: "Assigned.", data: undefined };
}

/** Round-robin to the next online member of the conversation's team (or the default team). */
export async function autoAssignConversation(conversationId: string): Promise<ActionResult> {
  const member = await requireMember();
  const { error, conversation } = await visibleConversation(member, conversationId);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  let teamId = conversation.assignee_team_id;
  if (!teamId) {
    const { data: org } = await admin
      .from("orgs")
      .select("settings")
      .eq("id", member.orgId)
      .single();
    teamId = readInboxSettings(org?.settings).default_team_id;
  }
  if (!teamId)
    return {
      ok: false,
      error: "No team to assign from. Pick a team first or set a default team in Settings → Inbox.",
    };
  const { data: userId } = await admin.rpc("pick_round_robin_assignee", {
    p_org_id: member.orgId,
    p_team_id: teamId,
  });
  if (!userId) return { ok: false, error: "Nobody on that team is online right now." };
  return assignConversation({
    conversation_id: conversation.id,
    user_id: userId as string,
    team_id: teamId,
  });
}

const statusSchema = z.object({ conversation_id: uuid, status: z.enum(["open", "waiting"]) });

export async function setConversationStatus(
  input: z.input<typeof statusSchema>,
): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  await admin
    .from("conversations")
    .update({ status: parsed.data.status, closed_at: null, closed_by: null })
    .eq("id", conversation.id);
  if (parsed.data.status === "waiting")
    await emit(member.orgId, "conversation.waiting", { conversation_id: conversation.id });
  refresh();
  return {
    ok: true,
    message: parsed.data.status === "waiting" ? "Marked as waiting for the patient." : "Reopened.",
    data: undefined,
  };
}

const closeSchema = z.object({
  conversation_id: uuid,
  category_id: uuid.nullable(),
  summary: z.string().trim().max(2000).default(""),
});

export async function closeConversation(input: z.input<typeof closeSchema>): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const settings = readInboxSettings(org?.settings);
  if (settings.require_category_on_close && !parsed.data.category_id)
    return { ok: false, error: "Pick a category to close this conversation." };
  if (settings.require_summary_on_close && !parsed.data.summary)
    return { ok: false, error: "Write a short summary to close this conversation." };
  const { error: upErr } = await admin
    .from("conversations")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: member.userId,
      category_id: parsed.data.category_id,
      summary: parsed.data.summary || null,
      bot_active: false,
    })
    .eq("id", conversation.id);
  if (upErr) return { ok: false, error: "Could not close the conversation." };
  await takeOverFromBot(admin, conversation.id, "Conversation closed");
  await emit(member.orgId, "conversation.closed", {
    conversation_id: conversation.id,
    category_id: parsed.data.category_id,
    by: member.userId,
  });
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: conversation.contact_id,
    type: "conversation.closed",
    actorType: "user",
    actorId: member.userId,
    payload: {
      conversation_id: conversation.id,
      category_id: parsed.data.category_id,
      summary: parsed.data.summary || null,
    },
  });
  refresh();
  return { ok: true, message: "Conversation closed.", data: undefined };
}

const labelSchema = z.object({ conversation_id: uuid, tag_id: uuid, on: z.boolean() });

export async function toggleConversationLabel(
  input: z.input<typeof labelSchema>,
): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  if (parsed.data.on) {
    const { error: e } = await admin.from("conversation_labels").upsert(
      {
        org_id: member.orgId,
        conversation_id: conversation.id,
        tag_id: parsed.data.tag_id,
        added_by: member.userId,
      },
      { onConflict: "conversation_id,tag_id" },
    );
    if (e) return { ok: false, error: "Could not add the label." };
  } else {
    await admin
      .from("conversation_labels")
      .delete()
      .eq("conversation_id", conversation.id)
      .eq("tag_id", parsed.data.tag_id);
  }
  refresh();
  return { ok: true, data: undefined };
}

export async function setBotActive(conversationId: string, active: boolean): Promise<ActionResult> {
  const member = await requireMember();
  const { error, conversation } = await visibleConversation(member, conversationId);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  if (active) await admin.from("conversations").update({ bot_active: true }).eq("id", conversation.id);
  else await takeOverFromBot(admin, conversation.id, "Agent took over");
  refresh();
  return {
    ok: true,
    message: active ? "Handed to the bot." : "You took over from the bot.",
    data: undefined,
  };
}

// ---------------------------------------------------------------------------
// New conversation, views, contact edits, merge
// ---------------------------------------------------------------------------

const startSchema = z.object({
  channel_id: uuid,
  contact_id: uuid.nullish(),
  phone: z.string().trim().max(30).nullish(),
  first_name: z.string().trim().max(60).optional().default(""),
  last_name: z.string().trim().max(60).optional().default(""),
});

/** "+" new conversation, or switching an existing contact to another number. */
export async function startConversation(
  input: z.input<typeof startSchema>,
): Promise<ActionResult<{ conversation_id: string }>> {
  const member = await requirePerm("inbox.send");
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { data: channel } = await admin
    .from("channels")
    .select("id, status")
    .eq("id", parsed.data.channel_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!channel || channel.status !== "active")
    return { ok: false, error: "Pick an active number." };

  let contactId = parsed.data.contact_id ?? null;
  if (!contactId) {
    const phone = toE164(parsed.data.phone);
    if (!phone) return { ok: false, error: "Enter a valid phone number (e.g. +971 50 000 0000)." };
    const { data: existing } = await admin
      .from("contacts")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("phone_e164", phone)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) contactId = existing.id;
    else {
      if (!can(member, "contacts.manage"))
        return { ok: false, error: "No contact with that number, and you can't create contacts." };
      const { data: created, error } = await admin
        .from("contacts")
        .insert({
          org_id: member.orgId,
          phone_e164: phone,
          first_name: parsed.data.first_name,
          last_name: parsed.data.last_name,
          source: "inbox",
          owner_id: member.userId,
        })
        .select("id")
        .single();
      if (error || !created) return { ok: false, error: "Could not create the contact." };
      contactId = created.id;
      await emit(member.orgId, "contact.created", { contact_id: contactId, source: "inbox" });
    }
  }
  const { data: live } = await admin
    .from("conversations")
    .select("id")
    .eq("channel_id", channel.id)
    .eq("contact_id", contactId)
    .neq("status", "closed")
    .maybeSingle();
  if (live) return { ok: true, data: { conversation_id: live.id } };
  const { data: conv, error } = await admin
    .from("conversations")
    .insert({
      org_id: member.orgId,
      channel_id: channel.id,
      contact_id: contactId,
      status: "open",
      assignee_user_id: member.userId,
    })
    .select("id")
    .single();
  if (error || !conv) return { ok: false, error: "Could not open the conversation." };
  await emit(member.orgId, "conversation.opened", {
    conversation_id: conv.id,
    contact_id: contactId,
    channel_id: channel.id,
    by: member.userId,
  });
  refresh();
  return { ok: true, data: { conversation_id: conv.id } };
}

const viewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filter: z.record(z.string(), z.unknown()),
  shared_team_ids: z.array(uuid).default([]),
  shared_all: z.boolean().default(false),
});

export async function saveInboxView(
  id: string | null,
  input: z.input<typeof viewSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requireMember();
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const row = {
    org_id: member.orgId,
    owner_id: member.userId,
    name: parsed.data.name,
    filter: parsed.data.filter as NonNullable<Json>,
    shared_team_ids: parsed.data.shared_team_ids,
    shared_all: parsed.data.shared_all,
  };
  if (id) {
    const { data } = await admin
      .from("inbox_views")
      .update(row)
      .eq("id", id)
      .eq("owner_id", member.userId)
      .select("id")
      .maybeSingle();
    if (!data) return { ok: false, error: "View not found (only the owner can edit it)." };
    refresh();
    return { ok: true, data: { id: data.id }, message: "View saved." };
  }
  const { data, error } = await admin.from("inbox_views").insert(row).select("id").single();
  if (error || !data) return { ok: false, error: "Could not save the view." };
  refresh();
  return { ok: true, data: { id: data.id }, message: "View saved." };
}

export async function deleteInboxView(id: string): Promise<ActionResult> {
  const member = await requireMember();
  const admin = createAdminClient();
  const { data } = await admin
    .from("inbox_views")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("owner_id", member.userId)
    .select("id")
    .maybeSingle();
  if (!data) return { ok: false, error: "View not found (only the owner can delete it)." };
  refresh();
  return { ok: true, message: "View deleted.", data: undefined };
}

const contactSchema = z.object({
  contact_id: uuid,
  first_name: z.string().trim().max(60).default(""),
  last_name: z.string().trim().max(60).default(""),
  email: z.string().trim().email().or(z.literal("")).default(""),
  language: z.string().trim().max(10).default(""),
  gender: z.enum(["female", "male", "other", "unknown", ""]).default(""),
  nationality: z.string().trim().max(60).default(""),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(""))
    .default(""),
  promotions_opt_in: z.boolean().default(false),
  stop_marketing: z.boolean().default(false),
});

export async function updateContactFromInbox(
  input: z.input<typeof contactSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contacts")
    .update({
      first_name: d.first_name,
      last_name: d.last_name,
      email: d.email || null,
      language: d.language || null,
      gender: d.gender || null,
      nationality: d.nationality || null,
      dob: d.dob || null,
      promotions_opt_in: d.promotions_opt_in,
      stop_marketing: d.stop_marketing,
    })
    .eq("id", d.contact_id)
    .eq("org_id", member.orgId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Could not update the contact." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.updated",
    entity: "contact",
    entityId: d.contact_id,
    diff: { fields: Object.keys(d).filter((k) => k !== "contact_id") },
  });
  refresh();
  return { ok: true, message: "Contact saved.", data: undefined };
}

/**
 * Merge `duplicate` into `primary` from the inbox sidebar: conversations move
 * first (closing the duplicate's live one where the primary already has one on
 * that number), then Phase 2's merge_contacts RPC does the contact-level merge.
 */
export async function mergeContacts(primaryId: string, duplicateId: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  if (primaryId === duplicateId) return { ok: false, error: "Pick two different contacts." };
  const admin = createAdminClient();
  const { data: both } = await admin
    .from("contacts")
    .select("id")
    .eq("org_id", member.orgId)
    .in("id", [primaryId, duplicateId])
    .is("deleted_at", null);
  if ((both ?? []).length !== 2) return { ok: false, error: "Contact not found." };

  const { data: primaryLive } = await admin
    .from("conversations")
    .select("channel_id")
    .eq("contact_id", primaryId)
    .neq("status", "closed");
  const busy = new Set((primaryLive ?? []).map((c) => c.channel_id));
  const { data: dupLive } = await admin
    .from("conversations")
    .select("id, channel_id")
    .eq("contact_id", duplicateId)
    .neq("status", "closed");
  for (const c of dupLive ?? []) {
    if (busy.has(c.channel_id)) {
      await admin
        .from("conversations")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
          summary: "Closed on contact merge.",
        })
        .eq("id", c.id);
    }
  }
  await admin.from("conversations").update({ contact_id: primaryId }).eq("contact_id", duplicateId);
  const { error } = await admin.rpc("merge_contacts", {
    p_org_id: member.orgId,
    p_primary_id: primaryId,
    p_secondary_id: duplicateId,
    p_fields: {},
    p_user_id: member.userId,
  });
  if (error) return { ok: false, error: `Merge failed: ${error.message}` };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.merged",
    entity: "contact",
    entityId: primaryId,
    diff: { merged: duplicateId, from: "inbox" },
  });
  refresh();
  revalidatePath("/contacts");
  return { ok: true, message: "Contacts merged.", data: undefined };
}

/** Conversations for a contact (Contacts drawer → Inbox tab). RLS decides what the caller sees. */
export async function listContactConversations(
  contactId: string,
): Promise<
  ActionResult<
    Array<{
      id: string;
      status: string;
      channel: string;
      last_message_at: string | null;
      preview: string | null;
      unread: number;
    }>
  >
> {
  await requireMember();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, status, last_message_at, last_message_preview, unread_count, channels(name)")
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (error) return { ok: false, error: "Could not load conversations." };
  return {
    ok: true,
    data: (data ?? []).map((c) => ({
      id: c.id,
      status: c.status,
      channel: c.channels?.name ?? "WhatsApp",
      last_message_at: c.last_message_at,
      preview: c.last_message_preview,
      unread: c.unread_count,
    })),
  };
}

/** Short-lived URL for an inbox media file (members only; path must be in the caller's org). */
export async function signedMediaUrl(path: string): Promise<ActionResult<{ url: string }>> {
  const member = await requireMember();
  const parts = parseMediaPath(path);
  if (!parts || parts.orgId !== member.orgId) return { ok: false, error: "Not found." };
  // The file lives under a conversation: the caller must be allowed to see that conversation (RLS).
  const supabase = await createClient();
  const { data: visible } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", parts.conversationId)
    .maybeSingle();
  if (!visible) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return { ok: false, error: "Could not load the file." };
  return { ok: true, data: { url: data.signedUrl } };
}

// ---------------------------------------------------------------------------
// Shortcut flows (manual flow start from the composer)
// ---------------------------------------------------------------------------

export type ShortcutFlow = { id: string; name: string; description: string | null };

export async function listShortcutFlows(): Promise<ActionResult<ShortcutFlow[]>> {
  const member = await requireMember();
  if (!can(member, "inbox.send")) return { ok: false, error: "You don't have permission for that." };
  const admin = createAdminClient();
  const { data } = await admin
    .from("flows")
    .select("id, name, description")
    .eq("org_id", member.orgId)
    .eq("trigger_type", "shortcut")
    .eq("status", "active")
    .order("name");
  return { ok: true, data: data ?? [] };
}

const shortcutSchema = z.object({ conversation_id: uuid, flow_id: uuid });

export async function runShortcut(input: z.input<typeof shortcutSchema>): Promise<ActionResult<{ run_id: string }>> {
  const member = await requireMember();
  const parsed = shortcutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const { error, conversation } = await visibleConversation(member, parsed.data.conversation_id);
  if (error || !conversation) return { ok: false, error: error ?? "Conversation not found." };
  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("id, name, trigger_type, status")
    .eq("id", parsed.data.flow_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow || flow.trigger_type !== "shortcut" || flow.status !== "active")
    return { ok: false, error: "That shortcut is not available." };
  const deps = createFlowDeps(admin);
  const res = await startRun(deps, {
    flowId: flow.id,
    contactId: conversation.contact_id,
    conversationId: conversation.id,
    trigger: { event: "shortcut", by: member.userId },
    startedBy: member.userId,
  });
  if (!res.started) {
    return {
      ok: false,
      error:
        res.reason === "live_run_exists"
          ? "A bot flow is already running in this conversation. Take over first."
          : "That shortcut is not available.",
    };
  }
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: conversation.contact_id,
    type: "flow.started",
    actorType: "user",
    actorId: member.userId,
    payload: { flow_id: flow.id, flow_name: flow.name, run_id: res.runId, via: "shortcut" },
  });
  refresh();
  return { ok: true, message: `Started "${flow.name}".`, data: { run_id: res.runId } };
}
