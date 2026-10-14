"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { generateAppealDraft } from "@/lib/finance/appeal-server";
import { CASE_STATUSES, canMoveCase, closeNeedsNote, type CaseStatus } from "@/lib/finance/denials";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Denial management. Every action needs finance.denials.manage. Appeal letters are DRAFTS: nothing here sends them, and
 * "mark as sent" only records that a person sent it themselves, outside Pulse.
 */

const PERM = "finance.denials.manage";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}
const refresh = (id?: string) => {
  revalidatePath("/finance/denials");
  if (id) revalidatePath(`/finance/denials/${id}`);
};

/** Opens, refreshes and recovers cases from the Diligence claims right now (the nightly job does the same). */
export async function syncDenialCases(): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_sync_denial_cases", {
    p_org_id: member.orgId,
    p_limit: 1000,
  });
  if (error) return fail("Could not refresh the cases.");
  const r = (data ?? {}) as { skipped?: string; opened?: number; recovered?: number };
  if (r.skipped === "not_enabled")
    return fail(
      "Denial cases are switched off. Set “Open denial cases from” in Settings, Finance workflow settings first.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.synced",
    entity: "ins_denial_cases",
    diff: { opened: r.opened ?? 0, recovered: r.recovered ?? 0 },
  });
  refresh();
  return { ok: true, message: `${r.opened ?? 0} case(s) opened, ${r.recovered ?? 0} recovered.` };
}

const assignSchema = z.object({ id: uuid, owner: z.union([uuid, z.literal("")]) });

export async function assignDenialCase(raw: { id: string; owner: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = assignSchema.safeParse(raw);
  if (!p.success) return fail("Choose a person.");
  const admin = createAdminClient(member.userId);
  if (p.data.owner) {
    const { data: m } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("user_id", p.data.owner)
      .eq("status", "active")
      .maybeSingle();
    if (!m) return fail("That person is not an active member.");
  }
  const { data, error } = await admin
    .from("ins_denial_cases")
    .update({ owner_user_id: p.data.owner || null })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not assign the case."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.assigned",
    entity: "ins_denial_cases",
    entityId: p.data.id,
  });
  refresh(p.data.id);
  return { ok: true, message: p.data.owner ? "Assigned." : "Unassigned." };
}

const statusSchema = z.object({
  id: uuid,
  to: z.enum(CASE_STATUSES.filter((s) => s !== "recovered") as [CaseStatus, ...CaseStatus[]]),
  note: z.string().trim().max(200).default(""),
});

export async function setDenialStatus(raw: {
  id: string;
  to: string;
  note?: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = statusSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Choose a valid status."));
  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("ins_denial_cases")
    .select("status")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return fail("That case was not found.");
  if (!canMoveCase(current.status as CaseStatus, p.data.to))
    return fail("The case cannot move to that status from where it is now.");
  const closing = closeNeedsNote(p.data.to);
  if (closing && p.data.note.length < 3)
    return fail("Write a short reason before closing the case.");
  const { data, error } = await admin
    .from("ins_denial_cases")
    .update({
      status: p.data.to,
      ...(closing
        ? {
            resolved_at: new Date().toISOString(),
            resolved_by: member.userId,
            resolution: p.data.note,
          }
        : {}),
    })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .eq("status", current.status)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not change the status."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.status_changed",
    entity: "ins_denial_cases",
    entityId: p.data.id,
    diff: { to: p.data.to },
  });
  refresh(p.data.id);
  return { ok: true, message: "Status updated." };
}

const noteSchema = z.object({
  id: uuid,
  note: z
    .string()
    .trim()
    .min(1, "Write a note.")
    .max(2000, "Keep the note under 2,000 characters."),
});

export async function addDenialNote(raw: { id: string; note: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = noteSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data: c } = await admin
    .from("ins_denial_cases")
    .select("id")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!c) return fail("That case was not found.");
  const { error } = await admin.from("ins_denial_notes").insert({
    org_id: member.orgId,
    case_id: p.data.id,
    user_id: member.userId,
    note: p.data.note,
  });
  if (error) return fail(dbMessage(error, "Could not save the note."));
  // the note text is health-adjacent free text: the audit row says a note was added, nothing more
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.note_added",
    entity: "ins_denial_cases",
    entityId: p.data.id,
  });
  refresh(p.data.id);
  return { ok: true, message: "Note added." };
}

const appealSchema = z.object({
  id: uuid,
  mode: z.enum(["ai", "template"]),
  language: z.enum(["en", "ar"]).default("en"),
});

/** Writes an appeal DRAFT (AI when the workspace has AI on, otherwise the standard template). It never sends anything. */
export async function createAppealDraft(raw: {
  id: string;
  mode: string;
  language?: string;
}): Promise<ActionResult<{ draftId: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = appealSchema.safeParse(raw);
  if (!p.success) return fail("Choose how to write the draft.");
  const admin = createAdminClient(member.userId);
  const res = await generateAppealDraft(admin, {
    orgId: member.orgId,
    orgName: member.org.name,
    orgSettings: member.org.settings,
    userId: member.userId,
    caseId: p.data.id,
    mode: p.data.mode,
    language: p.data.language,
    today: todayIn(member.org.timezone),
  });
  if (!res.ok) return res;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.appeal_drafted",
    entity: "ins_denial_cases",
    entityId: p.data.id,
    diff: { kind: res.data!.kind, flags: res.data!.flags.length },
  });
  refresh(p.data.id);
  return {
    ok: true,
    data: { draftId: res.data!.draftId },
    message:
      res.data!.notice ??
      (res.data!.kind === "ai"
        ? "Draft written. Read it carefully before you use it."
        : "Draft ready."),
  };
}

export async function discardAppealDraft(draftId: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(draftId).success) return fail("Invalid draft.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("ins_appeal_drafts")
    .update({ status: "discarded" })
    .eq("id", draftId)
    .eq("org_id", member.orgId)
    .eq("status", "draft")
    .select("case_id");
  if (error || !data?.length) return fail("Could not discard that draft.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.appeal_discarded",
    entity: "ins_appeal_drafts",
    entityId: draftId,
  });
  refresh(data[0].case_id);
  return { ok: true, message: "Draft discarded." };
}

/** Records that the person sent this letter themselves, through the payer's own channel. Pulse sends nothing. */
export async function markAppealSent(draftId: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(draftId).success) return fail("Invalid draft.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("ins_appeal_drafts")
    .update({
      status: "marked_sent",
      marked_sent_by: member.userId,
      marked_sent_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .eq("org_id", member.orgId)
    .eq("status", "draft")
    .select("case_id");
  if (error || !data?.length) return fail("Could not record that.");
  await admin
    .from("ins_denial_cases")
    .update({ status: "appealed" })
    .eq("id", data[0].case_id)
    .eq("org_id", member.orgId)
    .in("status", ["open", "in_progress"]);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.appeal_marked_sent",
    entity: "ins_appeal_drafts",
    entityId: draftId,
  });
  refresh(data[0].case_id);
  return { ok: true, message: "Recorded. The case is now marked as appealed." };
}
