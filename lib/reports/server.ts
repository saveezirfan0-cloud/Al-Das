import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { resolveRange } from "@/lib/reports/range";
import type { ReportFilters } from "@/lib/reports/filters";
import type { ReportContext } from "@/lib/reports/types";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/** Report context for the caller's org: timezone-aware range, service-role client (callers run can() first). */
export function reportContext(member: CurrentMember, filters: ReportFilters, now = new Date()): ReportContext {
  const timezone = member.org.timezone || "UTC";
  return {
    admin: createAdminClient(),
    orgId: member.orgId,
    timezone,
    filters,
    range: resolveRange(filters, timezone, now),
  };
}

export async function availableSources(admin: AdminClient): Promise<string[]> {
  const { data } = await admin.rpc("report_sources_available");
  return data ?? [];
}

export type FilterOptions = {
  channels: Array<{ value: string; label: string }>;
  teams: Array<{ value: string; label: string }>;
  users: Array<{ value: string; label: string }>;
};

export async function filterOptions(admin: AdminClient, orgId: string): Promise<FilterOptions> {
  const [{ data: channels }, { data: teams }, { data: members }] = await Promise.all([
    admin.from("channels").select("id, name").eq("org_id", orgId).order("name"),
    admin.from("teams").select("id, name").eq("org_id", orgId).order("name"),
    admin.from("memberships").select("user_id").eq("org_id", orgId).eq("status", "active"),
  ]);
  const ids = (members ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length
    ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", ids)
    : { data: [] };
  return {
    channels: (channels ?? []).map((c) => ({ value: c.id, label: c.name })),
    teams: (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    users: (profiles ?? [])
      .map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}`.trim() || p.email || "Unnamed" }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
