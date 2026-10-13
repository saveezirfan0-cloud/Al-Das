import "server-only";

import { recordAudit } from "@/lib/audit";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import {
  createEnquiry,
  EnquiryError,
  moveStage,
  setStatus,
  updateEnquiry,
} from "@/lib/enquiries/service";
import { emit } from "@/lib/events/emit";
import { takeOverFromBot } from "@/lib/flow-engine/takeover";
import {
  applyCloseEnquiry,
  validateCloseEnquiry,
  type CloseEnquiryPart,
  type CloseEnquiryTarget,
} from "@/lib/inbox/close-enquiry";
import { readInboxSettings } from "@/lib/inbox/settings";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Closes a conversation with its category and summary: the row, the bot hand-over, the domain event and the contact
 * timeline entry. Shared by the plain close and the Phase 20d close-with-enquiry action; callers check permissions
 * and the workspace's "required on close" settings first.
 */
export async function closeConversationRecord(
  admin: AdminClient,
  a: {
    orgId: string;
    userId: string;
    conversationId: string;
    contactId: string;
    categoryId: string | null;
    summary: string | null;
  },
): Promise<boolean> {
  const { error } = await admin
    .from("conversations")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: a.userId,
      category_id: a.categoryId,
      summary: a.summary || null,
      bot_active: false,
    })
    .eq("id", a.conversationId)
    .eq("org_id", a.orgId);
  if (error) return false;
  await takeOverFromBot(admin, a.conversationId, "Conversation closed");
  await emit(a.orgId, "conversation.closed", {
    conversation_id: a.conversationId,
    category_id: a.categoryId,
    by: a.userId,
  });
  await addTimelineEvent(admin, {
    orgId: a.orgId,
    contactId: a.contactId,
    type: "conversation.closed",
    actorType: "user",
    actorId: a.userId,
    payload: {
      conversation_id: a.conversationId,
      category_id: a.categoryId,
      summary: a.summary || null,
    },
  });
  return true;
}

export type CloseWithEnquiryResult =
  | { ok: true; enquiryId: string; created: boolean; number: number | null }
  | { ok: false; error: string };

/**
 * Phase 20d close-with-enquiry, after the caller checked inbox.send on the conversation and enquiries.manage (and
 * contacts.view for a new enquiry). Writes the enquiry first through the enquiry service (its own history, audit and
 * events); only then closes the conversation, and writes one audit row for the combined step (ids and step names
 * only, never the summary). If the enquiry part fails, the conversation stays open.
 */
export async function closeWithEnquiry(
  admin: AdminClient,
  actor: { orgId: string; userId: string },
  conversation: { id: string; contact_id: string; channel_id: string | null },
  input: { category_id: string | null; summary: string; enquiry: CloseEnquiryPart },
): Promise<CloseWithEnquiryResult> {
  const { data: org } = await admin.from("orgs").select("settings").eq("id", actor.orgId).single();
  const settings = readInboxSettings(org?.settings);
  if (settings.require_category_on_close && !input.category_id)
    return { ok: false, error: "Pick a category to close this conversation." };
  if (settings.require_summary_on_close && !input.summary)
    return { ok: false, error: "Write a short summary to close this conversation." };

  const part = input.enquiry;
  let target: CloseEnquiryTarget | null = null;
  if (part.mode === "update") {
    const { data } = await admin
      .from("enquiries")
      .select("id, status, stage_id, pipeline_id, contact_id")
      .eq("org_id", actor.orgId)
      .eq("id", part.enquiry_id)
      .is("deleted_at", null)
      .maybeSingle();
    target = data ? { ...data, status: data.status as EnquiryStatus } : null;
  }
  const pipelineId = part.mode === "create" ? part.pipeline_id : (target?.pipeline_id ?? null);
  const { data: stages } = pipelineId
    ? await admin
        .from("stages")
        .select("id")
        .eq("org_id", actor.orgId)
        .eq("pipeline_id", pipelineId)
    : { data: [] as Array<{ id: string }> };
  const problem = validateCloseEnquiry(part, {
    contactId: conversation.contact_id,
    target,
    pipelineStageIds: (stages ?? []).map((s) => s.id),
  });
  if (problem) return { ok: false, error: problem };

  const ctx = { admin, orgId: actor.orgId, userId: actor.userId };
  // The enquiry's source is the conversation's channel (website chat, Instagram and Messenger since Phase 20e).
  const { data: channel } = conversation.channel_id
    ? await admin.from("channels").select("type").eq("id", conversation.channel_id).maybeSingle()
    : { data: null };
  const source = channel?.type === "web" ? "website" : (channel?.type ?? "whatsapp");
  let result;
  try {
    result = await applyCloseEnquiry(
      {
        create: (i) =>
          createEnquiry(ctx, {
            title: i.title,
            pipelineId: i.pipelineId,
            stageId: i.stageId,
            contactId: i.contactId,
            channelId: i.channelId,
            source,
            apptDate: i.apptDate,
          }),
        moveStage: (id, stageId) => moveStage(ctx, id, stageId),
        setStatus: (id, status, reason) => setStatus(ctx, id, status, reason),
        setApptDate: (id, apptDate) => updateEnquiry(ctx, id, { apptDate }),
      },
      part,
      { contactId: conversation.contact_id, channelId: conversation.channel_id, target },
    );
  } catch (e) {
    if (e instanceof EnquiryError) return { ok: false, error: e.message };
    console.error("[inbox] close with enquiry failed", e instanceof Error ? e.name : "unknown");
    return { ok: false, error: "Could not save the enquiry. The conversation is still open." };
  }

  const closed = await closeConversationRecord(admin, {
    orgId: actor.orgId,
    userId: actor.userId,
    conversationId: conversation.id,
    contactId: conversation.contact_id,
    categoryId: input.category_id,
    summary: input.summary || null,
  });
  await recordAudit(admin, {
    orgId: actor.orgId,
    userId: actor.userId,
    action: "conversation.closed_with_enquiry",
    entity: "conversation",
    entityId: conversation.id,
    diff: {
      enquiry_id: result.enquiryId,
      enquiry_created: result.created,
      steps: result.steps,
      category_id: input.category_id,
      closed,
    },
  });
  if (!closed)
    return {
      ok: false,
      error:
        "The enquiry was saved, but the conversation could not be closed. Try closing it again.",
    };
  return { ok: true, enquiryId: result.enquiryId, created: result.created, number: result.number };
}
