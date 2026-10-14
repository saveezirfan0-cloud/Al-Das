import "server-only";

import { canSeeLocation, type BranchAccess } from "@/lib/branches/access";
import type { AdminClient } from "@/lib/supabase/admin";

export type DeskOptions = {
  timezone: string;
  /** Only the branches the member may work in (Phase B). */
  locations: Array<{ id: string; name: string }>;
  /** The branch the dialogs start on (the switcher's choice, home or only branch); null = let the person pick. */
  currentLocationId?: string | null;
  specialists: Array<{ id: string; name: string; location_ids: string[]; service_ids: string[] }>;
  services: Array<{ id: string; name: string; duration_min: number }>;
};

/** Places, doctors (with where they work and what they do) and services: what the desk dialogs choose from. */
export async function loadDeskOptions(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  /** Phase B: limits the places (and each doctor's places) to the member's branches; omit for no limit. */
  branch?: { access: BranchAccess; current: string | null },
): Promise<DeskOptions> {
  const [locs, specs, specLocs, specSvcs, svcs] = await Promise.all([
    admin.from("locations").select("id, name").eq("org_id", orgId).eq("active", true).order("name"),
    admin
      .from("specialists")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name"),
    admin.from("specialist_locations").select("specialist_id, location_id").eq("org_id", orgId),
    admin.from("specialist_services").select("specialist_id, service_id").eq("org_id", orgId),
    admin
      .from("services")
      .select("id, name, duration_min")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name"),
  ]);
  const allowed = (id: string) => !branch || canSeeLocation(branch.access, id);
  const placesOf = (specialistId: string) =>
    (specLocs.data ?? []).filter((x) => x.specialist_id === specialistId).map((x) => x.location_id);
  return {
    timezone,
    locations: (locs.data ?? []).filter((l) => allowed(l.id)),
    currentLocationId: branch?.current ?? null,
    specialists: (specs.data ?? [])
      // A doctor who works only in branches this member may not see is not offered.
      .filter((s) => {
        const places = placesOf(s.id);
        return places.length === 0 || places.some(allowed);
      })
      .map((s) => ({
        id: s.id,
        name: s.name,
        location_ids: placesOf(s.id).filter(allowed),
        service_ids: (specSvcs.data ?? [])
          .filter((x) => x.specialist_id === s.id)
          .map((x) => x.service_id),
      })),
    services: svcs.data ?? [],
  };
}
