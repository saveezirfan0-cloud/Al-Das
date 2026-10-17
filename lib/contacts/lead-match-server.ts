import "server-only";

import { decideLeadMatches, type LeadPatientPair, type PersonRef } from "@/lib/contacts/lead-match";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Sanoflow lead to Unite patient candidates for the duplicates panel. Service role, after `contacts.view` was checked by
 * the caller; org scoped. The database proposes cheap candidate pairs, lib/contacts/lead-match.ts decides. Only ids,
 * names, dates and phone numbers already shown on the duplicates panel are read; nothing is logged.
 */
export async function findLeadPatientPairs(
  admin: AdminClient,
  orgId: string,
  limit = 100,
): Promise<LeadPatientPair[]> {
  const { data: blocks, error } = await admin.rpc("lead_patient_blocks", {
    p_org_id: orgId,
    p_limit: 400,
  });
  if (error) throw new Error("lead-patient candidates failed");
  if (!blocks || blocks.length === 0) return [];
  const ids = [...new Set(blocks.flatMap((b) => [b.lead_id, b.patient_id]))];

  const people: PersonRef[] = [];
  // Chunked: a few hundred ids per request keeps the URL short.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [{ data: rows }, { data: alts }] = await Promise.all([
      admin
        .from("contacts")
        .select("id, full_name, dob, phone_e164, external_id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .in("id", chunk),
      admin
        .from("contact_phones")
        .select("contact_id, phone_e164")
        .eq("org_id", orgId)
        .in("contact_id", chunk),
    ]);
    const altBy = new Map<string, string[]>();
    for (const a of alts ?? [])
      altBy.set(a.contact_id, [...(altBy.get(a.contact_id) ?? []), a.phone_e164]);
    for (const r of rows ?? [])
      people.push({
        id: r.id,
        fullName: r.full_name,
        dob: r.dob,
        phone: r.phone_e164,
        altPhones: altBy.get(r.id) ?? [],
        externalId: r.external_id,
      });
  }
  return decideLeadMatches(
    people,
    blocks.map((b) => ({ leadId: b.lead_id, patientId: b.patient_id })),
  ).slice(0, limit);
}
