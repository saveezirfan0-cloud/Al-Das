import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

/** Resolvers from what a person types (an appointment number, a claim number, a Unite PIN) to ids, always inside one org. */

/** Appointments are numbered per organisation (appointments.number). */
export async function appointmentIdByNumber(
  admin: AdminClient,
  orgId: string,
  number: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const { data } = await admin
    .from("appointments")
    .select("id")
    .eq("org_id", orgId)
    .eq("number", number)
    .maybeSingle();
  return data?.id ?? null;
}

export async function claimIdByNumber(
  admin: AdminClient,
  orgId: string,
  claimNumber: string,
): Promise<string | null> {
  const { data } = await admin
    .from("ins_claim_activities")
    .select("id")
    .eq("org_id", orgId)
    .eq("claim_activity_number", claimNumber.trim())
    .maybeSingle();
  return data?.id ?? null;
}

/** The platform contact whose Unite PIN (contacts.external_id) this is; null when unknown or erased/merged away. */
export async function contactIdByPin(
  admin: AdminClient,
  orgId: string,
  pin: string,
): Promise<string | null> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("external_id", pin.trim())
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .maybeSingle();
  return data?.id ?? null;
}
