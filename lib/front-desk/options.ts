import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export type DeskOptions = {
  timezone: string;
  locations: Array<{ id: string; name: string }>;
  specialists: Array<{ id: string; name: string; location_ids: string[]; service_ids: string[] }>;
  services: Array<{ id: string; name: string; duration_min: number }>;
};

/** Places, doctors (with where they work and what they do) and services: what the desk dialogs choose from. */
export async function loadDeskOptions(
  admin: AdminClient,
  orgId: string,
  timezone: string,
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
  return {
    timezone,
    locations: locs.data ?? [],
    specialists: (specs.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      location_ids: (specLocs.data ?? [])
        .filter((x) => x.specialist_id === s.id)
        .map((x) => x.location_id),
      service_ids: (specSvcs.data ?? [])
        .filter((x) => x.specialist_id === s.id)
        .map((x) => x.service_id),
    })),
    services: svcs.data ?? [],
  };
}
