import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export type Option = { id: string; name: string };

export type ReferenceData = {
  users: Array<{ id: string; label: string }>;
  teams: Option[];
  channels: Option[];
  locations: Option[];
  departments: Option[];
  specialists: Option[];
  services: Option[];
};

/** Lookups behind the enquiry filters, drawer and settings: one parallel batch, org-scoped. */
export async function loadReferenceData(admin: AdminClient, orgId: string): Promise<ReferenceData> {
  const named = (table: "teams" | "channels" | "locations" | "departments" | "specialists" | "services") =>
    admin.from(table).select("id, name").eq("org_id", orgId).order("name");
  const active = (table: "locations" | "departments" | "specialists" | "services") =>
    admin.from(table).select("id, name").eq("org_id", orgId).eq("active", true).order("name");
  const [members, teams, channels, locations, departments, specialists, services] = await Promise.all([
    admin
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", orgId)
      .eq("status", "active"),
    named("teams"),
    named("channels"),
    active("locations"),
    active("departments"),
    active("specialists"),
    active("services"),
  ]);
  const users = (members.data ?? [])
    .map((m) => ({
      id: m.user_id,
      label:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        m.user_id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    users,
    teams: teams.data ?? [],
    channels: channels.data ?? [],
    locations: locations.data ?? [],
    departments: departments.data ?? [],
    specialists: specialists.data ?? [],
    services: services.data ?? [],
  };
}
