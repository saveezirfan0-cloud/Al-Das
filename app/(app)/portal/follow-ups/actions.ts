"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { createNotification } from "@/lib/notifications";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Only the columns staff own. Engine columns (category, dedupe key, visit...) are never accepted. */
const updateSchema = z.object({
  id: z.string().uuid(),
  callStatus: z.enum(["pending", "completed", "escalated", "no_answer"]),
  outcome: z.enum(["improving", "same", "worse"]).nullable(),
  escalationStatus: z.enum(["none", "open", "escalated", "resolved"]),
  doctorResponseNotes: z.string().max(4000).nullable(),
  notes: z.string().max(4000).nullable(),
  assignedUserId: z.string().uuid().nullable(),
  close: z.boolean().default(false),
});

export async function updateFollowUp(input: z.input<typeof updateSchema>): Promise<ActionResult> {
  const member = await requirePerm("portal.clinical_followups.write");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("clinical_followups")
    .select("id, closed_at")
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Follow-up not found." };

  if (d.assignedUserId) {
    const { data: m } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("user_id", d.assignedUserId)
      .eq("status", "active")
      .maybeSingle();
    if (!m) return { ok: false, error: "That person is not a member of this organisation." };
  }
  if (d.close && d.callStatus === "pending")
    return { ok: false, error: "Record the call result before closing." };

  const { error } = await admin
    .from("clinical_followups")
    .update({
      call_status: d.callStatus,
      outcome: d.outcome,
      escalation_status: d.escalationStatus,
      doctor_response_notes: d.doctorResponseNotes?.trim() || null,
      notes: d.notes?.trim() || null,
      assigned_user_id: d.assignedUserId,
      ...(d.close ? { closed_at: new Date().toISOString(), closed_reason: "completed" } : {}),
    })
    .eq("id", d.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save." };

  // The audit entry names the follow-up and the status change only: no notes, no patient details.
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: d.close ? "clinical_followup.close" : "clinical_followup.update",
    entity: "clinical_followup",
    entityId: d.id,
    diff: { call_status: d.callStatus, escalation_status: d.escalationStatus },
  });
  revalidatePath("/portal/follow-ups");
  return { ok: true, message: d.close ? "Closed." : "Saved." };
}

/** Pings the visit's doctor (if linked to a Pulse user) and stamps doctor_notified_at. */
export async function notifyDoctor(id: string): Promise<ActionResult> {
  const member = await requirePerm("portal.clinical_followups.write");
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient();

  const { data: f } = await admin
    .from("clinical_followups")
    .select("id, visit_id, ref")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!f) return { ok: false, error: "Follow-up not found." };

  const { data: visit } = f.visit_id
    ? await admin
        .from("visits")
        .select("specialist_id")
        .eq("id", f.visit_id)
        .eq("org_id", member.orgId)
        .maybeSingle()
    : { data: null };
  const { data: doctor } = visit?.specialist_id
    ? await admin
        .from("specialists")
        .select("user_id")
        .eq("id", visit.specialist_id)
        .eq("org_id", member.orgId)
        .maybeSingle()
    : { data: null };
  if (!doctor?.user_id)
    return {
      ok: false,
      error: "This visit's doctor is not linked to a Pulse user. Call them directly.",
    };

  await createNotification(admin, {
    orgId: member.orgId,
    userId: doctor.user_id,
    type: "clinical.doctor_review",
    title: "A patient follow-up needs your review",
    body: "Open the Follow-Up Queue to see the details.",
    payload: { followup_id: f.id },
  });
  await admin
    .from("clinical_followups")
    .update({
      doctor_notified_at: new Date().toISOString(),
      escalation_status: "open",
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "clinical_followup.notify_doctor",
    entity: "clinical_followup",
    entityId: id,
  });
  revalidatePath("/portal/follow-ups");
  return { ok: true, message: "Doctor notified." };
}
