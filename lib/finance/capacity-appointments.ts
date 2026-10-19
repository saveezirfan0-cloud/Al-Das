/**
 * Booked against available, per doctor, for the Capacity page (docs/48_CAPACITY_APPOINTMENTS_NOTES.md). Pure: the server
 * loader gathers the inputs. Counts and hours only: no PIN, no patient name, no appointment id leaves this file.
 *
 * Source: the Unite appointment export uploaded on Finance, Appointments and invoices (W2, fin_appt_rows), measured the
 * W2 way (`doctorUtilisation`: booked = not cancelled, seen = honoured, hours from the file, blank when any booked
 * appointment has no length). Available hours are the Capacity page's own (working hours on open days minus blocks and
 * leave), reached through the one doctor link (specialists.report_doctor_key, the Doctors page).
 *
 * THE COVERAGE RULE (a figure is shown only when the file covers the doctor's month and branches; otherwise the cell
 * keeps "Needs Unite appointments" with the reason):
 *   no_upload          no current appointment row in the month
 *   part_month         the uploads cover only part of the month
 *   branch_unmapped    the chosen branch, or one of the doctor's working branches in view, has no finance branch code,
 *                      so its appointments cannot be told apart
 *   branch_not_in_file one of the doctor's working branches in view has no appointment at all in the month's file (that
 *                      clinic was not exported)
 *   unknown_branch     the doctor has appointments whose clinic is not mapped to a branch, and this member may not see
 *                      unknown-branch rows (23B rule): the figure would understate
 *   not_linked         the doctor has no link to a Unite doctor name
 * Branch rule (23B): appointments are kept to what `branchVisible` allows; the page's branch choice narrows, never
 * widens. A doctor with no working hours in view gets counts but no percentage.
 */

import {
  branchVisible,
  doctorUtilisation,
  type ApptIn,
  type BranchScope,
} from "@/lib/finance/appointment-billing";

export type NoBookingReason =
  | "no_upload"
  | "part_month"
  | "branch_unmapped"
  | "branch_not_in_file"
  | "unknown_branch"
  | "not_linked";

export const NO_BOOKING_LABEL: Record<NoBookingReason, string> = {
  no_upload: "No appointment file for this month",
  part_month: "The appointment file covers part of the month",
  branch_unmapped: "A branch has no finance branch code",
  branch_not_in_file: "A branch of this doctor is not in the appointment file",
  unknown_branch: "Some appointments have a clinic not mapped to a branch",
  not_linked: "Not linked to a Unite doctor",
};

export type BookedCell =
  | {
      kind: "figure";
      /** Appointments that are not cancelled. */
      booked: number;
      seen: number;
      cancelled: number;
      /** Null when a booked appointment has no length in the file. */
      bookedHours: number | null;
      availableHours: number;
      /** bookedHours / availableHours in percent (one decimal); null when either is unknown or zero. */
      bookedPct: number | null;
      noDuration: number;
    }
  | { kind: "none"; reason: NoBookingReason };

/** An appointment row as the loader reads it: no PIN. */
export type CapacityApptRow = Omit<ApptIn, "pin">;

export type CapacityBookingDoctor = {
  specialistId: string;
  /** specialists.report_doctor_key; null = not linked. */
  doctorKey: string | null;
  availableHours: number;
  /** Finance branch codes of the doctor's working-hours branches in view; null = a branch with no code. */
  branches: readonly (string | null)[];
};

export type CapacityBookingsInput = {
  /** True when at least one current appointment row is dated in the month. */
  hasRows: boolean;
  /** The uploads cover the whole month. */
  fullMonth: boolean;
  /** Every current row of the month (all branches: the rule applies the member's view itself). */
  rows: readonly CapacityApptRow[];
  view: BranchScope;
  doctors: readonly CapacityBookingDoctor[];
};

export type CapacityBookings = {
  bySpecialist: Map<string, BookedCell>;
  totals: {
    /** Doctors with a figure. */
    doctors: number;
    booked: number;
    /** Over the doctors with both booked hours and available hours. */
    bookedHours: number;
    availableHours: number;
    /** bookedHours / availableHours in percent (one decimal); null when nothing qualifies. */
    bookedPct: number | null;
  };
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (h: number, avail: number) => (avail > 0 ? Math.round((h / avail) * 1000) / 10 : null);

export function capacityBookings(input: CapacityBookingsInput): CapacityBookings {
  const bySpecialist = new Map<string, BookedCell>();
  const none = (reason: NoBookingReason): BookedCell => ({ kind: "none", reason });

  const fileBranches = new Set(input.rows.flatMap((r) => (r.branch ? [r.branch] : [])));
  const visible = input.rows.filter((r) => branchVisible(input.view, r.branch));
  const hiddenUnknown = new Set(
    input.rows
      .filter((r) => r.branch === null && !branchVisible(input.view, r.branch))
      .map((r) => r.doctorKey),
  );
  const hoursOfKey = new Map<string, number>();
  for (const d of input.doctors)
    if (d.doctorKey)
      hoursOfKey.set(d.doctorKey, (hoursOfKey.get(d.doctorKey) ?? 0) + d.availableHours);
  const util = new Map(
    doctorUtilisation(
      visible.map((r) => ({ ...r, pin: null })),
      (key) => hoursOfKey.get(key) ?? null,
    ).map((u) => [u.key, u]),
  );

  let booked = 0;
  let bookedHours = 0;
  let availableHours = 0;
  let doctors = 0;
  for (const d of input.doctors) {
    const cell: BookedCell = (() => {
      if (!input.hasRows) return none("no_upload");
      if (!input.fullMonth) return none("part_month");
      if (!input.view.available || d.branches.some((b) => b === null))
        return none("branch_unmapped");
      if (d.branches.some((b) => b !== null && !fileBranches.has(b)))
        return none("branch_not_in_file");
      if (!d.doctorKey) return none("not_linked");
      if (hiddenUnknown.has(d.doctorKey)) return none("unknown_branch");
      const u = util.get(d.doctorKey);
      const h = u?.bookedHours ?? (u ? null : 0);
      return {
        kind: "figure",
        booked: u?.booked ?? 0,
        seen: u?.seen ?? 0,
        cancelled: u?.cancelled ?? 0,
        bookedHours: h,
        availableHours: d.availableHours,
        bookedPct: h === null ? null : pct(h, d.availableHours),
        noDuration: u?.noDuration ?? 0,
      };
    })();
    bySpecialist.set(d.specialistId, cell);
    if (cell.kind === "figure") {
      doctors++;
      booked += cell.booked;
      if (cell.bookedHours !== null && cell.availableHours > 0) {
        bookedHours += cell.bookedHours;
        availableHours += cell.availableHours;
      }
    }
  }
  return {
    bySpecialist,
    totals: {
      doctors,
      booked,
      bookedHours: round2(bookedHours),
      availableHours: round2(availableHours),
      bookedPct: pct(bookedHours, availableHours),
    },
  };
}
