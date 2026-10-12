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
  optionalAmount,
  optionalDate,
  optionalInt,
  optionalText,
  parseCodeList,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { appointmentIdByNumber, claimIdByNumber, contactIdByPin } from "@/lib/finance/lookup-db";
import { canTransition, validateApproval, type PreauthStatus } from "@/lib/finance/preauth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pre-authorisation tracker. Every action needs finance.preauth.manage. Writes use the service role with the signed-in
 * person's id attached so the History tab names them; rows carry the Unite PIN and the payer's reference only.
 */

const PERM = "finance.preauth.manage";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const text = z.string().trim();
const base = z.object({
  pin: text.max(60),
  payer_id: text.min(1, "Enter the payer ID.").max(60),
  cpt_codes: text.max(400).default(""),
  appointment_number: optionalInt(),
  claim_number: optionalText(80),
  requested_on: optionalDate,
  reference_note: optionalText(200),
});

const createSchema = base.extend({ status: z.enum(["draft", "requested"]).default("requested") });

export async function createPreauth(
  raw: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = createSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const d = p.data;
  const admin = createAdminClient(member.userId);
  const pin = d.pin || null;
  if (!pin) return fail("Enter the patient's Unite PIN.");
  const [contactId, appointmentId, claimId] = await Promise.all([
    contactIdByPin(admin, member.orgId, pin),
    d.appointment_number === null
      ? null
      : appointmentIdByNumber(admin, member.orgId, d.appointment_number),
    d.claim_number === null ? null : claimIdByNumber(admin, member.orgId, d.claim_number),
  ]);
  if (d.appointment_number !== null && !appointmentId)
    return fail("No appointment has that number.");
  if (d.claim_number !== null && !claimId) return fail("No claim has that number.");
  const { data, error } = await admin
    .from("fin_pre_authorisations")
    .insert({
      org_id: member.orgId,
      patient_pin: pin,
      contact_id: contactId,
      payer_id: d.payer_id,
      cpt_codes: parseCodeList(d.cpt_codes),
      appointment_id: appointmentId,
      claim_activity_id: claimId,
      status: d.status,
      requested_on:
        d.status === "requested"
          ? (d.requested_on ?? todayIn(member.org.timezone))
          : d.requested_on,
      requested_by: member.userId,
      reference_note: d.reference_note,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return fail(dbMessage(error, "Could not save the pre-authorisation."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.preauth.created",
    entity: "fin_pre_authorisations",
    entityId: data.id,
    diff: { status: d.status },
  });
  revalidatePath("/finance/preauth");
  return { ok: true, data: { id: data.id }, message: "Pre-authorisation saved." };
}

const updateSchema = base.omit({ pin: true, requested_on: true }).extend({ id: uuid });

/** Edit the details that do not change the decision: services, the appointment and claim it belongs to, the note. */
export async function updatePreauth(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = updateSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const d = p.data;
  const admin = createAdminClient(member.userId);
  const appointmentId =
    d.appointment_number === null
      ? null
      : await appointmentIdByNumber(admin, member.orgId, d.appointment_number);
  const claimId =
    d.claim_number === null ? null : await claimIdByNumber(admin, member.orgId, d.claim_number);
  if (d.appointment_number !== null && !appointmentId)
    return fail("No appointment has that number.");
  if (d.claim_number !== null && !claimId) return fail("No claim has that number.");
  const { data, error } = await admin
    .from("fin_pre_authorisations")
    .update({
      payer_id: d.payer_id,
      cpt_codes: parseCodeList(d.cpt_codes),
      appointment_id: appointmentId,
      claim_activity_id: claimId,
      reference_note: d.reference_note,
    })
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not save the changes."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.preauth.updated",
    entity: "fin_pre_authorisations",
    entityId: d.id,
  });
  revalidatePath("/finance/preauth");
  return { ok: true, message: "Saved." };
}

const decisionSchema = z.object({
  id: uuid,
  decision: z.enum(["approved", "partially_approved", "denied"]),
  auth_number: optionalText(80),
  decision_on: optionalDate,
  valid_from: optionalDate,
  expires_on: optionalDate,
  approved_amount: optionalAmount,
  approved_units: optionalInt(100000),
});

/** The payer's answer. An approval needs the payer's reference and the date it expires. */
export async function recordPreauthDecision(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = decisionSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const d = p.data;
  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("fin_pre_authorisations")
    .select("status")
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return fail("That pre-authorisation was not found.");
  if (!canTransition(current.status as PreauthStatus, d.decision))
    return fail("That pre-authorisation cannot move to that status from where it is now.");
  if (d.decision !== "denied") {
    const problem = validateApproval({
      authNumber: d.auth_number,
      expiresOn: d.expires_on,
      validFrom: d.valid_from,
    });
    if (problem) return fail(problem);
  }
  const { data, error } = await admin
    .from("fin_pre_authorisations")
    .update({
      status: d.decision,
      auth_number: d.auth_number,
      decision_on: d.decision_on ?? todayIn(member.org.timezone),
      valid_from: d.valid_from,
      expires_on: d.expires_on,
      approved_amount: d.approved_amount,
      approved_units: d.approved_units,
      expiry_notified_at: null,
    })
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .eq("status", current.status)
    .select("id");
  if (error || !data?.length)
    return fail(
      dbMessage(
        error,
        "Could not record the decision. Check the authorisation number is not already used for this payer.",
      ),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.preauth.decided",
    entity: "fin_pre_authorisations",
    entityId: d.id,
    diff: { decision: d.decision },
  });
  revalidatePath("/finance/preauth");
  return { ok: true, message: "Decision recorded." };
}

const statusSchema = z.object({ id: uuid, to: z.enum(["requested", "cancelled", "used"]) });

export async function changePreauthStatus(raw: { id: string; to: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = statusSchema.safeParse(raw);
  if (!p.success) return fail("Choose a valid status.");
  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("fin_pre_authorisations")
    .select("status")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return fail("That pre-authorisation was not found.");
  if (!canTransition(current.status as PreauthStatus, p.data.to))
    return fail("That pre-authorisation cannot move to that status from where it is now.");
  const patch =
    p.data.to === "requested"
      ? {
          status: p.data.to,
          requested_on: todayIn(member.org.timezone),
          auth_number: null,
          expires_on: null,
        }
      : { status: p.data.to };
  const { data, error } = await admin
    .from("fin_pre_authorisations")
    .update(patch)
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .eq("status", current.status)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not change the status."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.preauth.status_changed",
    entity: "fin_pre_authorisations",
    entityId: p.data.id,
    diff: { to: p.data.to },
  });
  revalidatePath("/finance/preauth");
  return { ok: true, message: "Status updated." };
}
