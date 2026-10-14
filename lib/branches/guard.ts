import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { branchView, type BranchView } from "@/lib/branches/server";
import type { AdminClient } from "@/lib/supabase/admin";

/** What a server action says when a row or a chosen branch is outside the member's branches. */
export const BRANCH_DENIED = "That belongs to a branch you do not work in.";

type BranchMember = Pick<CurrentMember, "orgId" | "branchScope" | "branchIds" | "homeLocationId">;
type BranchTable = "appointments" | "waitlist_entries" | "handover_notes" | "enquiries";

/**
 * The member's branch view for a server action (no page has loaded the locations): reads the org's active
 * locations, then the switcher cookie (lib/branches/server.ts).
 */
export async function memberBranchView(
  admin: AdminClient,
  member: BranchMember,
): Promise<BranchView> {
  const { data } = await admin
    .from("locations")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("active", true)
    .order("name");
  return branchView(
    member,
    (data ?? []).map((l) => l.id),
  );
}

/** May the member choose this branch for a new or moved row? (No branch is always allowed.) */
export function branchAllowed(
  member: Pick<BranchMember, "branchScope" | "branchIds" | "homeLocationId">,
  locationId: string | null | undefined,
): boolean {
  return canSeeLocation(readBranchAccess(member), locationId);
}

/**
 * True when the row exists and belongs to a branch the member may not see (the service-role twin of the RLS rule).
 * An unrestricted member never costs a query. A missing row returns false so the caller's own not-found handling runs.
 */
export async function rowOutsideBranches(
  admin: AdminClient,
  member: BranchMember,
  table: BranchTable,
  id: string,
): Promise<boolean> {
  const access = readBranchAccess(member);
  if (access.scope === "all") return false;
  const { data } = await admin
    .from(table as "appointments")
    .select("location_id")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!data) return false;
  return !canSeeLocation(access, data.location_id);
}
