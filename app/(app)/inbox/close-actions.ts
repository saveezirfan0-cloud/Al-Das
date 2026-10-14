"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { loadPipelines } from "@/lib/enquiries/server";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { canSeeEnquiry, enquiryViewer, visibleEnquiryIds } from "@/lib/enquiries/visibility";
import { closeWithEnquiry } from "@/lib/inbox/close";
import { closeEnquiryPartSchema } from "@/lib/inbox/close-enquiry";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 20d close-with-enquiry (G10). Closing a conversation stays inbox.send; touching the enquiry needs
 * enquiries.manage on top (and contacts.view to link a new enquiry to the patient), exactly like the Enquiries page.
 */

export type CloseActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

export type CloseEnquiryOptions = {
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  /** The patient's open enquiries, newest first. */
  enquiries: Array<{
    id: string;
    number: number;
    title: string;
    pipeline_id: string;
    stage_id: string;
    status: string;
  }>;
  lostReasons: string[];
};

const uuid = z.string().uuid();

async function visibleConversation(member: CurrentMember, conversationId: string) {
  if (!can(member, "inbox.send")) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, org_id, contact_id, channel_id, status")
    .eq("id", conversationId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return data;
}

/** What the close dialog offers: pipelines with stages, the patient's open enquiries and the lost-reason list. */
export async function loadCloseEnquiryOptions(
  conversationId: string,
): Promise<CloseActionResult<CloseEnquiryOptions>> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(conversationId).success)
    return { ok: false, error: "Conversation not found." };
  const conversation = await visibleConversation(member, conversationId);
  if (!conversation) return { ok: false, error: "Conversation not found." };
  const admin = createAdminClient(member.userId);
  const [pipelines, { data: enquiries }, { data: org }] = await Promise.all([
    loadPipelines(admin, member.orgId),
    admin
      .from("enquiries")
      .select("id, number, title, pipeline_id, stage_id, status")
      .eq("org_id", member.orgId)
      .eq("contact_id", conversation.contact_id)
      .eq("status", "open")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
    admin.from("orgs").select("settings").eq("id", member.orgId).single(),
  ]);
  // Phase 20c: a restricted enquiry view only lists the enquiries this person may see.
  const open = enquiries ?? [];
  const visible = new Set(
    await visibleEnquiryIds(
      admin,
      member.orgId,
      await enquiryViewer(admin, member),
      open.map((e) => e.id),
    ),
  );
  return {
    ok: true,
    data: {
      pipelines: pipelines
        .filter((p) => !p.archived)
        .map((p) => ({
          id: p.id,
          name: p.name,
          stages: p.stages.map((s) => ({ id: s.id, name: s.name })),
        })),
      enquiries: open.filter((e) => visible.has(e.id)),
      lostReasons: readEnquirySettings(org?.settings).lost_reasons,
    },
  };
}

const closeWithEnquirySchema = z.object({
  conversation_id: uuid,
  category_id: uuid.nullable(),
  summary: z.string().trim().max(2000).default(""),
  enquiry: closeEnquiryPartSchema,
});

/**
 * One step: write the enquiry (create, or move / change status / set the appointment date on an open one) and close
 * the conversation (lib/inbox/close.ts closeWithEnquiry). The enquiry is written first; if it fails the conversation
 * stays open. Audited there as one row (ids and step names only) next to the enquiry service's own audit rows.
 */
export async function closeConversationWithEnquiry(
  input: z.input<typeof closeWithEnquirySchema>,
): Promise<CloseActionResult<{ enquiry_id: string }>> {
  const member = await requirePerm("enquiries.manage");
  const parsed = closeWithEnquirySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const conversation = await visibleConversation(member, v.conversation_id);
  if (!conversation) return { ok: false, error: "Conversation not found." };
  if (v.enquiry.mode === "create" && !can(member, "contacts.view"))
    return { ok: false, error: "You cannot link enquiries to patients." };

  // History (record_history) names the person: the admin client carries their id.
  const admin = createAdminClient(member.userId);
  if (
    v.enquiry.mode === "update" &&
    !(await canSeeEnquiry(
      admin,
      member.orgId,
      await enquiryViewer(admin, member),
      v.enquiry.enquiry_id,
    ))
  )
    return { ok: false, error: "Enquiry not found." };
  const r = await closeWithEnquiry(
    admin,
    { orgId: member.orgId, userId: member.userId },
    conversation,
    { category_id: v.category_id, summary: v.summary, enquiry: v.enquiry },
  );
  revalidatePath("/inbox");
  revalidatePath("/enquiries");
  if (!r.ok) return r;
  return {
    ok: true,
    message: r.created
      ? `Conversation closed. Enquiry #${r.number} created.`
      : "Conversation closed and enquiry updated.",
    data: { enquiry_id: r.enquiryId },
  };
}
