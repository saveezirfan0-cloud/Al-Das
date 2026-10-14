import "server-only";

import { readAppointmentSettings } from "@/lib/appointments/settings";
import type { CurrentMember } from "@/lib/auth/session";
import { branchFilterIds, canSeeLocation } from "@/lib/branches/access";
import { branchView } from "@/lib/branches/server";
import { availableMinutes, monthRange, openDates, rotaMinutes } from "@/lib/capacity/hours";
import { buildCapacityReport, revenueByDoctor, type CapacityReport } from "@/lib/capacity/measures";
import {
  allowedBranchCodes,
  coverageOf,
  parseDoctorPerformanceInputs,
  type Coverage,
} from "@/lib/finance/doctor-performance";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Loads the capacity page (M3). Service role only, so every caller checks finance.revenue.view first. Branch-bound
 * (Phase B): hours, rooms and rota are kept to the branches the member may see (and the page's branch choice); revenue
 * is kept to their finance branch codes exactly as the doctor performance report does (lib/finance/doctor-performance-
 * server.ts), and is shown as unavailable for a branch with no finance branch code rather than guessed.
 */

export const DEFAULT_ROOM_OPEN_HOURS = 10;

export type CapacityLocation = {
  id: string;
  name: string;
  timezone: string;
  branchCode: string | null;
};

export type CapacityScope = {
  /** Active branches the member may see (the branch filter's options). */
  locations: CapacityLocation[];
  /** The one branch shown, or null for all of `locations`. */
  chosen: string | null;
  /** Branch ids the figures cover. */
  scopeIds: string[];
  /** Finance branch codes the member may see; null = every branch. */
  allowedCodes: string[] | null;
  /** The finance branch code of the chosen branch (revenue filter). */
  revenueBranch: string | null;
  /** False when a chosen branch has no finance branch code, so its revenue cannot be told apart. */
  revenueAvailable: boolean;
};

const UUID = /^[0-9a-f-]{36}$/i;

export async function loadCapacityScope(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId" | "branchScope" | "branchIds" | "homeLocationId">,
  rawLocation: string | null | undefined,
): Promise<CapacityScope> {
  const { data, error } = await admin
    .from("locations")
    .select("id, name, timezone, branch_code, active")
    .eq("org_id", member.orgId)
    .order("name");
  if (error) throw new Error("Could not load the branches.");
  const all = data ?? [];
  const active = all.filter((l) => l.active);
  const view = await branchView(
    member,
    active.map((l) => l.id),
  );
  const visible = active.filter((l) => canSeeLocation(view.access, l.id));
  const wanted =
    rawLocation === "all"
      ? null
      : rawLocation && UUID.test(rawLocation)
        ? rawLocation
        : view.current;
  const chosen = wanted && visible.some((l) => l.id === wanted) ? wanted : null;
  const chosenLoc = visible.find((l) => l.id === chosen) ?? null;
  return {
    locations: visible.map((l) => ({
      id: l.id,
      name: l.name,
      timezone: l.timezone,
      branchCode: l.branch_code,
    })),
    chosen,
    scopeIds: chosen ? [chosen] : visible.map((l) => l.id),
    allowedCodes: allowedBranchCodes(branchFilterIds(view.access, null), all),
    revenueBranch: chosenLoc?.branch_code ?? null,
    revenueAvailable: !chosenLoc || !!chosenLoc.branch_code,
  };
}

export type UnlinkedKey = { doctorKey: string; doctorName: string; revenue: number };
export type DoctorKeyLink = {
  doctorKey: string;
  doctorName: string;
  specialistId: string;
  specialistName: string;
};

export type Capacity = {
  month: string;
  openDays: number;
  openHoursPerDay: number;
  report: CapacityReport;
  coverage: Coverage;
  hasRevenueData: boolean;
  unlinked: UnlinkedKey[];
  links: DoctorKeyLink[];
  specialists: { id: string; name: string }[];
};

const need = <T>(r: { data: T | null; error: unknown }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`Could not load ${what}.`);
  return r.data;
};

export async function loadCapacity(
  admin: AdminClient,
  orgId: string,
  scope: CapacityScope,
  month: string,
): Promise<Capacity> {
  const range = monthRange(month);
  const ids = scope.scopeIds.length > 0 ? scope.scopeIds : ["00000000-0000-0000-0000-000000000000"];

  const [org, settings, specialistsR, linksR, hoursR, weeklyR, blocksR, roomsR, perfR] =
    await Promise.all([
      admin.from("orgs").select("settings").eq("id", orgId).single(),
      admin
        .from("fin_ref_finance_settings")
        .select("room_open_hours_per_day")
        .eq("org_id", orgId)
        .maybeSingle(),
      admin.from("specialists").select("id, name, active").eq("org_id", orgId).order("name"),
      admin.from("fin_ref_doctor_keys").select("doctor_key, specialist_id").eq("org_id", orgId),
      fetchAll((lo, hi) =>
        admin
          .from("working_hours")
          .select("id, specialist_id, location_id, weekday, start_min, end_min")
          .eq("org_id", orgId)
          .in("location_id", ids)
          .order("id")
          .range(lo, hi),
      ),
      fetchAll((lo, hi) =>
        admin
          .from("specialist_recurring_blocks")
          .select("id, specialist_id, location_id, weekday, start_min, end_min")
          .eq("org_id", orgId)
          .order("id")
          .range(lo, hi),
      ),
      fetchAll((lo, hi) =>
        admin
          .from("time_blocks")
          .select("id, specialist_id, location_id, starts_at, ends_at")
          .eq("org_id", orgId)
          .lt("starts_at", range.to)
          .gt("ends_at", range.from)
          .order("id")
          .range(lo, hi),
      ),
      admin
        .from("rooms")
        .select("id, name, kind, location_id, monthly_cost")
        .eq("org_id", orgId)
        .eq("active", true)
        .in("location_id", ids)
        .order("name"),
      scope.revenueAvailable
        ? admin.rpc("fin_doctor_performance_inputs", {
            p_org_id: orgId,
            p_month: month,
            p_branch: scope.revenueBranch ?? undefined,
            p_branches: scope.allowedCodes ?? undefined,
          })
        : Promise.resolve({ data: null, error: null }),
    ]);
  if (perfR.error) throw new Error("Could not load the revenue figures.");

  const rooms = need(roomsR, "the rooms");
  const rotaR = await fetchAll((lo, hi) =>
    admin
      .from("room_rota")
      .select("id, room_id, specialist_id, weekday, start_min, end_min")
      .eq("org_id", orgId)
      .in(
        "room_id",
        rooms.length > 0 ? rooms.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"],
      )
      .order("id")
      .range(lo, hi),
  );

  const specialists = need(specialistsR, "the doctors");
  const keyRows = need(linksR, "the doctor links");
  const hours = need(hoursR, "the working hours");
  const weekly = need(weeklyR, "the weekly blocks");
  const blocks = need(blocksR, "the time blocks");
  const rota = need(rotaR, "the room rota");

  const appt = readAppointmentSettings(org.data?.settings);
  const open = openDates(month, appt.working_weekdays, appt.holidays);
  const openHoursPerDay = Number(settings.data?.room_open_hours_per_day ?? DEFAULT_ROOM_OPEN_HOURS);
  const tz = new Map(scope.locations.map((l) => [l.id, l.timezone]));

  // Revenue per doctor from the current report rows (summed over departments and over every key linked to the doctor).
  const perf = perfR.data ? parseDoctorPerformanceInputs(perfR.data) : null;
  const keyLinks = new Map(keyRows.map((k) => [k.doctor_key, k.specialist_id]));
  const reportRows = (perf?.current.doctors ?? []).map((d) => ({
    doctorKey: d.doctorKey,
    doctorName: d.doctorName,
    revenue: d.revenue,
  }));
  const revenue = revenueByDoctor(reportRows, keyLinks);
  const linked = new Set(keyRows.map((k) => k.specialist_id));

  // Doctors in scope: working hours or rota in the branches shown, or linked revenue there.
  const inScope = new Set<string>([
    ...hours.map((h) => h.specialist_id),
    ...rota.map((r) => r.specialist_id),
    ...revenue.bySpecialist.keys(),
  ]);

  const doctors = specialists
    .filter((s) => inScope.has(s.id))
    .map((s) => {
      const mine = hours.filter((h) => h.specialist_id === s.id);
      const locIds = [...new Set(mine.map((h) => h.location_id))];
      const minutes = availableMinutes({
        month,
        workingWeekdays: appt.working_weekdays,
        holidays: appt.holidays,
        locations: locIds.map((loc) => ({
          timezone: tz.get(loc) ?? "Asia/Dubai",
          workingHours: mine.filter((h) => h.location_id === loc),
          recurringBlocks: weekly.filter(
            (b) => b.specialist_id === s.id && (!b.location_id || b.location_id === loc),
          ),
          timeBlocks: blocks
            .filter((b) => b.specialist_id === s.id && (!b.location_id || b.location_id === loc))
            .map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) })),
        })),
      });
      return {
        specialistId: s.id,
        name: s.name,
        availableMinutes: minutes,
        revenue: linked.has(s.id) ? (revenue.bySpecialist.get(s.id) ?? 0) : null,
      };
    });

  const locationName = new Map(scope.locations.map((l) => [l.id, l.name]));
  const report = buildCapacityReport({
    openDays: open.length,
    openHoursPerDay,
    revenueAvailable: scope.revenueAvailable && !!perf,
    doctors,
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      locationName: locationName.get(r.location_id) ?? "",
      monthlyCost: r.monthly_cost === null ? null : Number(r.monthly_cost),
    })),
    rota: rotaMinutes(rota, open),
  });

  const nameOfKey = new Map(reportRows.map((r) => [r.doctorKey, r.doctorName]));
  const nameOfSpecialist = new Map(specialists.map((s) => [s.id, s.name]));
  return {
    month,
    openDays: open.length,
    openHoursPerDay,
    report,
    coverage: coverageOf(month, perf?.coverage ?? []),
    hasRevenueData: reportRows.length > 0,
    unlinked: revenue.unlinked,
    links: keyRows
      .map((k) => ({
        doctorKey: k.doctor_key,
        doctorName: nameOfKey.get(k.doctor_key) ?? k.doctor_key,
        specialistId: k.specialist_id,
        specialistName: nameOfSpecialist.get(k.specialist_id) ?? "Doctor",
      }))
      .sort((a, b) => a.specialistName.localeCompare(b.specialistName)),
    specialists: specialists.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
  };
}
