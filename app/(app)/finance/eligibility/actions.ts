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
  optionalDate,
  optionalText,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { appointmentIdByNumber, contactIdByPin } from "@/lib/finance/lookup-db";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Eligibility checks. Every action needs finance.eligibility.manage. A check points at the patient's insurance-card
 * document (Phase 16) by id only; listing a patient's cards ALSO needs documents.view, because documents.* is never
 * implied by finance rights. Rows carry the Unite PIN, the payer and dates: no names, no member IDs.
 */

const PERM = "finance.eligibility.manage";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const text = z.string().trim();
const checkFields = {
  payer_id: text.min(1, "Enter the payer ID.").max(60),
  appointment_number: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v > 0),
      "Enter a whole appointment number.",
    ),
  method: z.enum(["portal", "phone", "card_only", "other"]).default("portal"),
  status: z.enum(["pending", "verified", "failed", "expired"]),
  valid_from: optionalDate,
  valid_to: optionalDate,
  checked_on: optionalDate,
  document_id: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || uuid.safeParse(v).success, "Choose a card from the list."),
  result_note: optionalText(200),
};
const createSchema = z.object({
  pin: text.min(1, "Enter the patient's Unite PIN.").max(60),
  ...checkFields,
});
const updateSchema = z
  .object({ id: uuid, ...checkFields })
  .omit({ appointment_number: true, payer_id: true });

/** The document must be this patient's, ready, an insurance card, and not infected. Returns an error text or null. */
async function checkCard(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  contactId: string | null,
  documentId: string,
) {
  if (!contactId) return "That patient has no record in Pulse yet, so a card cannot be attached.";
  const { data } = await admin
    .from("patient_documents")
    .select("id, contact_id, category, status, scan_status")
    .eq("id", documentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data || data.contact_id !== contactId) return "That card does not belong to this patient.";
  if (data.category !== "insurance_card") return "Choose a document filed as an insurance card.";
  if (data.status !== "ready") return "That upload is not finished.";
  if (data.scan_status === "infected") return "That file was blocked by the scan.";
  return null;
}

export async function createEligibilityCheck(
  raw: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = createSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const d = p.data;
  if (d.status === "verified" && !d.valid_to)
    return fail("A verified check needs the date the cover ends.");
  const admin = createAdminClient(member.userId);
  const contactId = await contactIdByPin(admin, member.orgId, d.pin);
  const appointmentId =
    d.appointment_number === null
      ? null
      : await appointmentIdByNumber(admin, member.orgId, d.appointment_number);
  if (d.appointment_number !== null && !appointmentId)
    return fail("No appointment has that number.");
  if (d.document_id) {
    const problem = await checkCard(admin, member.orgId, contactId, d.document_id);
    if (problem) return fail(problem);
  }
  const { data, error } = await admin
    .from("fin_eligibility_checks")
    .insert({
      org_id: member.orgId,
      patient_pin: d.pin,
      contact_id: contactId,
      appointment_id: appointmentId,
      payer_id: d.payer_id,
      document_id: d.document_id,
      status: d.status,
      method: d.method,
      valid_from: d.valid_from,
      valid_to: d.valid_to,
      checked_on: d.checked_on ?? (d.status === "pending" ? null : todayIn(member.org.timezone)),
      checked_by: member.userId,
      result_note: d.result_note,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      dbMessage(error, "Could not save the check. A verified check needs the date the cover ends."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.eligibility.created",
    entity: "fin_eligibility_checks",
    entityId: data.id,
    diff: { status: d.status, has_card: !!d.document_id },
  });
  revalidatePath("/finance/eligibility");
  return { ok: true, data: { id: data.id }, message: "Check saved." };
}

export async function updateEligibilityCheck(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = updateSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const d = p.data;
  if (d.status === "verified" && !d.valid_to)
    return fail("A verified check needs the date the cover ends.");
  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("fin_eligibility_checks")
    .select("contact_id")
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return fail("That check was not found.");
  if (d.document_id) {
    const problem = await checkCard(admin, member.orgId, current.contact_id, d.document_id);
    if (problem) return fail(problem);
  }
  const { data, error } = await admin
    .from("fin_eligibility_checks")
    .update({
      status: d.status,
      method: d.method,
      valid_from: d.valid_from,
      valid_to: d.valid_to,
      checked_on: d.checked_on ?? (d.status === "pending" ? null : todayIn(member.org.timezone)),
      checked_by: member.userId,
      document_id: d.document_id,
      result_note: d.result_note,
    })
    .eq("id", d.id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not save the check."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.eligibility.updated",
    entity: "fin_eligibility_checks",
    entityId: d.id,
    diff: { status: d.status, has_card: !!d.document_id },
  });
  revalidatePath("/finance/eligibility");
  return { ok: true, message: "Check updated." };
}

export type CardChoice = { id: string; label: string; scan: string };

/**
 * The patient's insurance cards to choose from (no titles: they are health data). Needs documents.view as well, and the
 * look at a patient's documents is written to the record access log.
 */
export async function listCardDocuments(pin: string): Promise<ActionResult<CardChoice[]>> {
  const member = await gate();
  if (!member || !can(member, "documents.view")) return fail(DENIED);
  const parsed = text.min(1).max(60).safeParse(pin);
  if (!parsed.success) return fail("Enter the PIN first.");
  const admin = createAdminClient(member.userId);
  const contactId = await contactIdByPin(admin, member.orgId, parsed.data);
  if (!contactId) return { ok: true, data: [] };
  const { data } = await admin
    .from("patient_documents")
    .select("id, created_at, expires_on, scan_status")
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .eq("category", "insurance_card")
    .eq("status", "ready")
    .neq("scan_status", "infected")
    .order("created_at", { ascending: false })
    .limit(10);
  await recordAccess(admin, member, {
    entity: "document",
    action: "list",
    detail: { category: "insurance_card", contact_id: contactId },
  });
  return {
    ok: true,
    data: (data ?? []).map((d) => ({
      id: d.id,
      label: `Insurance card added ${d.created_at.slice(0, 10)}${d.expires_on ? `, expires ${d.expires_on}` : ""}`,
      scan: d.scan_status,
    })),
  };
}
