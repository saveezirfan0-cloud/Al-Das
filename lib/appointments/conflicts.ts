import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export type CapacityConflict = "blocked" | "full";

/**
 * Phase 20c: which of these appointments break today's capacity rules (blocks, weekly blocks, buffers,
 * places), e.g. a Unite appointment booked in Unite over a lunch block. Same SQL rule as book_appointment
 * (app.slot_conflict), read-only: nothing is refused or changed. Call only after the caller's permission check.
 * A failure returns an empty map so a list never fails because of the flag.
 */
export async function loadCapacityConflicts(
  admin: AdminClient,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, CapacityConflict>> {
  const out = new Map<string, CapacityConflict>();
  if (ids.length === 0) return out;
  const { data, error } = await admin.rpc("appointment_capacity_conflicts", {
    p_org_id: orgId,
    p_ids: ids.slice(0, 2000),
  });
  if (error) {
    console.error("[appointments] conflict check failed", { code: error.code });
    return out;
  }
  for (const row of data ?? []) {
    if (row.reason === "blocked" || row.reason === "full") out.set(row.appointment_id, row.reason);
  }
  return out;
}
