import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { loadPerfScope } from "@/lib/finance/doctor-performance-server";
import {
  CALENDAR_KINDS,
  parseBenchmarks,
  type Benchmarks,
  type CalendarEvent,
  type CalendarKind,
} from "@/lib/finance/recruitment";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads what the recruitment calculator (M4) reads: the clinic's defaults and benchmarks (public.fin_recruitment_
 * benchmarks, amounts and counts only, branch-scoped like doctor performance) and the dated calendar events. Service
 * role only: every caller has checked finance.profit.view AND finance.costs.compensation first.
 */

export const RECRUIT_PERMS = ["finance.profit.view", "finance.costs.compensation"] as const;

export async function loadBenchmarks(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId" | "branchScope" | "branchIds" | "homeLocationId">,
): Promise<Benchmarks> {
  const scope = await loadPerfScope(admin, member);
  const { data, error } = await admin.rpc("fin_recruitment_benchmarks", {
    p_org_id: member.orgId,
    p_branches: scope.allowed ?? undefined,
  });
  if (error) throw new Error("Could not load the department benchmarks.");
  const b = parseBenchmarks(data);
  const s = b.settings;
  if (![s.conservativePct, s.consumablesPct, s.gatewayPct, s.minPeerMonths].every(Number.isFinite))
    throw new Error("The recruitment settings could not be read.");
  return b;
}

export async function loadCalendarEvents(
  admin: AdminClient,
  orgId: string,
): Promise<CalendarEvent[]> {
  const { data, error } = await admin
    .from("fin_ref_calendar_events")
    .select("id, starts_on, ends_on, kind, label, approximate")
    .eq("org_id", orgId)
    .order("starts_on");
  if (error) throw new Error("Could not load the calendar.");
  return (data ?? [])
    .filter((e) => (CALENDAR_KINDS as readonly string[]).includes(e.kind))
    .map((e) => ({
      id: e.id,
      startsOn: e.starts_on,
      endsOn: e.ends_on,
      kind: e.kind as CalendarKind,
      label: e.label,
      approximate: e.approximate,
    }));
}
