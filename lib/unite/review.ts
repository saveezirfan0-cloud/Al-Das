/**
 * Resolving a Sync Review item: a reviewer links an unmatched/ambiguous Unite patient to a
 * contact, creates the contact from what Unite sent, or dismisses the item. Linking also attaches
 * the appointments that were waiting on the patient and plans their reminders.
 */
import { syncAppointmentReminders } from "@/lib/appointments/service";
import { writePreparedContact, upsertExternalRef } from "@/lib/contacts/import-writer";
import type { PreparedContact } from "@/lib/contacts/import";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ReviewAction =
  { kind: "link"; contactId: string } | { kind: "create" } | { kind: "dismiss" };

export type ReviewResult =
  { ok: true; contactId: string | null; linkedAppointments: number } | { ok: false; error: string };

function incomingOf(raw: Json): {
  pin: string | null;
  name: string;
  phone: string | null;
  dob: string | null;
} {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    pin: str(o.pin),
    name: str(o.name) ?? "",
    phone: str(o.phone_e164),
    dob: str(o.dob),
  };
}

export async function resolveSyncReview(
  admin: AdminClient,
  o: { orgId: string; reviewId: string; userId: string; action: ReviewAction },
): Promise<ReviewResult> {
  const { data: review } = await admin
    .from("sync_reviews")
    .select("*")
    .eq("id", o.reviewId)
    .eq("org_id", o.orgId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review item not found." };
  if (review.status !== "open") return { ok: false, error: "This item was already handled." };
  const now = new Date().toISOString();

  if (o.action.kind === "dismiss") {
    await admin
      .from("sync_reviews")
      .update({ status: "dismissed", resolved_by: o.userId, resolved_at: now })
      .eq("id", review.id);
    return { ok: true, contactId: null, linkedAppointments: 0 };
  }

  const incoming = incomingOf(review.incoming);
  let contactId: string;

  if (o.action.kind === "link") {
    const { data: contact } = await admin
      .from("contacts")
      .select("id, external_id")
      .eq("id", o.action.contactId)
      .eq("org_id", o.orgId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!contact) return { ok: false, error: "That patient was not found." };
    if (incoming.pin && contact.external_id && contact.external_id !== incoming.pin)
      return { ok: false, error: "That patient already has a different Unite PIN." };
    if (incoming.pin && !contact.external_id) {
      const { error } = await admin
        .from("contacts")
        .update({ external_id: incoming.pin })
        .eq("id", contact.id)
        .eq("org_id", o.orgId);
      if (error) return { ok: false, error: "Another patient already uses that Unite PIN." };
    }
    contactId = contact.id;
  } else {
    if (!incoming.name && !incoming.phone)
      return { ok: false, error: "Unite sent no name or phone to create a patient from." };
    const parts = incoming.name.split(/\s+/).filter(Boolean);
    const contact: PreparedContact = {
      first_name: parts[0] ?? "",
      last_name: parts.slice(1).join(" "),
      phone_e164: incoming.phone,
      alternate_phones: [],
      email: null,
      gender: null,
      nationality: null,
      country: null,
      language: null,
      dob: incoming.dob,
      label: null,
      external_id: incoming.pin,
      promotions_opt_in: null,
      stop_marketing: null,
      tags: [],
      source: "unite",
      note: null,
      custom: {},
    };
    const res = await writePreparedContact(admin, {
      orgId: o.orgId,
      existingId: null,
      contact,
      defaultSource: "unite",
      customFields: [],
      tagIds: new Map(),
      actorId: o.userId,
      batch: "sync-review",
    });
    if (!res.ok)
      return { ok: false, error: `${res.error} Link the item to the existing patient instead.` };
    contactId = res.id;
  }

  if (incoming.pin)
    await upsertExternalRef(admin, {
      orgId: o.orgId,
      source: "unite",
      entity: "patient",
      externalId: incoming.pin,
      localTable: "contacts",
      localId: contactId,
      meta: { via: "sync_review" },
    });

  // Attach the appointments that were waiting on this patient.
  const { data: waiting } = await admin
    .from("appointments")
    .select("id, org_id, contact_id, starts_at, status, custom")
    .eq("org_id", o.orgId)
    .eq("source", "unite")
    .is("contact_id", null)
    .filter("custom->>unite_patient_key", "eq", review.external_id);
  let linked = 0;
  for (const a of waiting ?? []) {
    const custom =
      a.custom && typeof a.custom === "object" && !Array.isArray(a.custom)
        ? { ...(a.custom as Record<string, Json>), unite_patient_name: null }
        : {};
    const { data: row } = await admin
      .from("appointments")
      .update({ contact_id: contactId, custom })
      .eq("id", a.id)
      .select("id, org_id, contact_id, starts_at, status")
      .single();
    if (!row) continue;
    linked++;
    await syncAppointmentReminders(admin, row);
  }

  await admin
    .from("sync_reviews")
    .update({
      status: "resolved",
      resolved_contact_id: contactId,
      resolved_by: o.userId,
      resolved_at: now,
    })
    .eq("id", review.id);
  await addTimelineEvent(admin, {
    orgId: o.orgId,
    contactId,
    type: "sync.patient_linked",
    actorId: o.userId,
    payload: { source: "unite", via: o.action.kind, appointments: linked },
  });
  return { ok: true, contactId, linkedAppointments: linked };
}
