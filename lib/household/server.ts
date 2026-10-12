import "server-only";

import type { HouseholdContact, HouseholdLink } from "@/lib/household/addressing";
import type { AdminClient } from "@/lib/supabase/admin";

const CONTACT_COLUMNS = "id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing";

/** The guardian link of a dependant (with the guardian's contact), or null for an ordinary patient. */
export async function loadHouseholdLink(
  admin: AdminClient,
  orgId: string,
  dependantId: string,
): Promise<HouseholdLink | null> {
  const { data } = await admin
    .from("household_links")
    .select(
      `reminders_to_guardian, guardian:contacts!household_links_guardian_contact_id_fkey(${CONTACT_COLUMNS}, deleted_at)`,
    )
    .eq("org_id", orgId)
    .eq("dependant_contact_id", dependantId)
    .maybeSingle();
  const guardian = data?.guardian as
    (HouseholdContact & { deleted_at: string | null }) | null | undefined;
  if (!data || !guardian || guardian.deleted_at) return null;
  return {
    guardian: {
      id: guardian.id,
      first_name: guardian.first_name,
      last_name: guardian.last_name,
      phone_e164: guardian.phone_e164,
      wa_bsuid: guardian.wa_bsuid,
      stop_marketing: guardian.stop_marketing,
    },
    reminders_to_guardian: data.reminders_to_guardian,
  };
}

/** Is `candidateId` the guardian of `dependantId`? Used so the guardian's Confirm/Cancel tap counts. */
export async function isGuardianOf(
  admin: AdminClient,
  orgId: string,
  candidateId: string,
  dependantId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("household_links")
    .select("id")
    .eq("org_id", orgId)
    .eq("guardian_contact_id", candidateId)
    .eq("dependant_contact_id", dependantId)
    .maybeSingle();
  return !!data;
}

/** Every contact id a message from `contactId` may speak for: itself and, if a guardian, its dependants. */
export async function contactsSpokenFor(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("household_links")
    .select("dependant_contact_id")
    .eq("org_id", orgId)
    .eq("guardian_contact_id", contactId);
  return [contactId, ...(data ?? []).map((l) => l.dependant_contact_id)];
}
