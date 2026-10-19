import "server-only";

import type { Capacity, CapacityScope } from "@/lib/capacity/server";
import { branchOfClinic, mergeRanges, type ApptStatus } from "@/lib/finance/appointment-billing";
import { branchScopeOf, loadBranchNames } from "@/lib/finance/appointment-billing-server";
import {
  capacityBookings,
  type CapacityApptRow,
  type CapacityBookings,
} from "@/lib/finance/capacity-appointments";
import { coverageOf, monthEnd, type Coverage } from "@/lib/finance/doctor-performance";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Booked against available for the Capacity page, from the W2 Unite appointment upload (fin_appt_rows, service role
 * only). Every caller has already checked finance.revenue.view. The patient PIN is never selected; the result holds
 * counts and hours only.
 */

export type CapacityBookingView = CapacityBookings & {
  coverage: Coverage;
  hasRows: boolean;
  /** True when the reads hit their safety ceiling (the figures are then withheld). */
  truncated: boolean;
};

const MAX_ROWS = 60_000;

export async function loadCapacityBookings(
  admin: AdminClient,
  orgId: string,
  scope: CapacityScope,
  capacity: Capacity,
): Promise<CapacityBookingView> {
  const month = capacity.month;
  const start = `${month.slice(0, 7)}-01`;
  const end = monthEnd(start);

  const [branches, rowsR] = await Promise.all([
    loadBranchNames(admin, orgId),
    fetchAll(
      (lo, hi) =>
        admin
          .from("fin_appt_rows")
          .select(
            "id, upload_id, appointment_id, appt_date, status, doctor_key, doctor_name, clinic_name, room, duration_min",
          )
          .eq("org_id", orgId)
          .eq("is_current", true)
          .gte("appt_date", start)
          .lte("appt_date", end)
          .order("id")
          .range(lo, hi),
      { max: MAX_ROWS },
    ),
  ]);
  if (rowsR.error || rowsR.data === null) throw new Error("Could not load the appointments.");
  const raw = rowsR.data;

  // coverage: the date ranges of the uploads that still hold current rows in this month, clipped to it
  const uploadIds = [...new Set(raw.map((r) => r.upload_id))];
  const ranges: { from: string; to: string }[] = [];
  if (uploadIds.length > 0) {
    const { data, error } = await admin
      .from("fin_appt_uploads")
      .select("from_date, to_date")
      .in("id", uploadIds);
    if (error) throw new Error("Could not load the uploads.");
    for (const u of data ?? [])
      ranges.push({
        from: u.from_date < start ? start : u.from_date,
        to: u.to_date > end ? end : u.to_date,
      });
  }
  const coverage = coverageOf(start, mergeRanges(ranges));

  const rows: CapacityApptRow[] = raw.map((a) => ({
    id: a.id,
    appointmentId: a.appointment_id,
    date: a.appt_date,
    status: a.status as ApptStatus,
    doctorKey: a.doctor_key,
    doctorName: a.doctor_name,
    branch: branchOfClinic(a.clinic_name, branches),
    room: a.room,
    minutes: a.duration_min,
  }));

  const codeOf = new Map(scope.locations.map((l) => [l.id, l.branchCode]));
  const result = capacityBookings({
    hasRows: rows.length > 0,
    // a truncated read is never shown as a figure
    fullMonth: coverage.full && !rowsR.truncated,
    rows,
    view: branchScopeOf(scope),
    doctors: capacity.report.doctors.map((d) => {
      const s = capacity.doctorScope[d.specialistId];
      return {
        specialistId: d.specialistId,
        doctorKey: s?.doctorKey ?? null,
        availableHours: d.availableHours,
        branches: (s?.locationIds ?? []).map((id) => codeOf.get(id) ?? null),
      };
    }),
  });
  return { ...result, coverage, hasRows: rows.length > 0, truncated: !!rowsR.truncated };
}
