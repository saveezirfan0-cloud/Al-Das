/**
 * Settling Sanoflow import reviews (sync_reviews with source 'sanoflow', Phase 20a) from
 * Portal → Sync review.
 *
 * - A contact review (several Pulse patients share the phone) can be linked to one patient: the
 *   Sanoflow contact id is recorded against that patient in external_refs, so the next import run
 *   updates it, and the enquiries and appointments that point at that Sanoflow contact follow it.
 * - An appointment review (busy slot, unknown or ambiguous patient) is settled by booking the visit
 *   by hand and re-running the import, which adopts the booking and resolves the review; if the
 *   visit was booked at another time, or is not needed, it is dismissed here.
 *
 * Sanoflow reviews never hold patient details (the importer stores none in `incoming`).
 */
import { upsertExternalRef } from "@/lib/contacts/import-writer";
import type { AdminClient } from "@/lib/supabase/admin";

export type SanoflowReviewAction = { kind: "dismiss" } | { kind: "link"; contactId: string };

/** What a person may do with a Sanoflow review of this entity. */
export function sanoflowReviewActions(entity: string): Array<SanoflowReviewAction["kind"]> {
  return entity === "contact" ? ["link", "dismiss"] : ["dismiss"];
}

export const SANOFLOW_REVIEW_HINTS: Record<string, string> = {
  multiple_matches:
    "Several patients in Pulse share this phone number. Link the Sanoflow record to the right one, or fix the duplicate and re-run the import.",
  appointment_contact_not_found:
    "No patient in Pulse matches this Sanoflow appointment. Import or create the patient, then re-run the import; or book the visit by hand and dismiss this.",
  appointment_slot_taken:
    "The specialist is already busy at this time in Pulse. Book the visit by hand (the same time adopts it on the next import run), or dismiss this if it was booked at another time.",
};

export async function resolveSanoflowReview(
  admin: AdminClient,
  o: { orgId: string; reviewId: string; userId: string; action: SanoflowReviewAction },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: review } = await admin
    .from("sync_reviews")
    .select("id, entity, external_id, status, source")
    .eq("id", o.reviewId)
    .eq("org_id", o.orgId)
    .eq("source", "sanoflow")
    .maybeSingle();
  if (!review) return { ok: false, error: "Review item not found." };
  if (review.status !== "open") return { ok: false, error: "This item was already handled." };
  if (!sanoflowReviewActions(review.entity).includes(o.action.kind))
    return { ok: false, error: "That action is not available for this item." };
  const now = new Date().toISOString();

  if (o.action.kind === "dismiss") {
    await admin
      .from("sync_reviews")
      .update({ status: "dismissed", resolved_by: o.userId, resolved_at: now })
      .eq("id", review.id)
      .eq("status", "open");
    return { ok: true };
  }

  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("id", o.action.contactId)
    .eq("org_id", o.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return { ok: false, error: "That patient was not found." };
  await upsertExternalRef(admin, {
    orgId: o.orgId,
    source: "sanoflow",
    entity: "contact",
    externalId: review.external_id,
    localTable: "contacts",
    localId: contact.id,
  });
  await admin
    .from("sync_reviews")
    .update({
      status: "resolved",
      resolved_contact_id: contact.id,
      resolved_by: o.userId,
      resolved_at: now,
    })
    .eq("id", review.id)
    .eq("status", "open");
  return { ok: true };
}
