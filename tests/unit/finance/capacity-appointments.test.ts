import { describe, expect, it } from "vitest";

import {
  capacityBookings,
  NO_BOOKING_LABEL,
  type CapacityApptRow,
  type CapacityBookingDoctor,
  type CapacityBookingsInput,
} from "@/lib/finance/capacity-appointments";

/**
 * Booked against available on the Capacity page (docs/48): the coverage rule (month, branch, doctor link), the 23B branch
 * rule, the W2 measures (cancelled not booked, blank hours when a length is missing) and the totals. Synthetic data only.
 */

let n = 0;
const row = (o: Partial<CapacityApptRow>): CapacityApptRow => ({
  id: `r${++n}`,
  appointmentId: `A${n}`,
  date: "2026-09-10",
  status: "honoured",
  doctorKey: "dr demo one",
  doctorName: "Dr Demo One",
  branch: "B1",
  room: null,
  minutes: 30,
  ...o,
});

const doctor = (o: Partial<CapacityBookingDoctor> = {}): CapacityBookingDoctor => ({
  specialistId: "S1",
  doctorKey: "dr demo one",
  availableHours: 10,
  branches: ["B1"],
  ...o,
});

const base = (o: Partial<CapacityBookingsInput> = {}): CapacityBookingsInput => ({
  hasRows: true,
  fullMonth: true,
  rows: [],
  view: { allowed: null, branch: null, available: true },
  doctors: [doctor()],
  ...o,
});

describe("capacityBookings", () => {
  it("sets booked hours against available hours (cancelled not booked, honoured seen)", () => {
    const r = capacityBookings(
      base({
        rows: [
          row({ minutes: 60 }),
          row({ status: "confirmed", minutes: 90 }),
          row({ status: "cancelled", minutes: 60 }),
          row({ doctorKey: "dr other", minutes: 600 }),
        ],
      }),
    );
    expect(r.bySpecialist.get("S1")).toEqual({
      kind: "figure",
      booked: 2,
      seen: 1,
      cancelled: 1,
      bookedHours: 2.5,
      availableHours: 10,
      bookedPct: 25,
      noDuration: 0,
    });
    expect(r.totals).toEqual({
      doctors: 1,
      booked: 2,
      bookedHours: 2.5,
      availableHours: 10,
      bookedPct: 25,
    });
  });

  it("keeps the no-data wording with the reason when the file does not cover the month", () => {
    expect(capacityBookings(base({ hasRows: false })).bySpecialist.get("S1")).toEqual({
      kind: "none",
      reason: "no_upload",
    });
    const part = capacityBookings(base({ fullMonth: false, rows: [row({})] }));
    expect(part.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "part_month" });
    expect(part.totals.bookedPct).toBeNull();
  });

  it("needs every working branch of the doctor in the file, each with a finance code", () => {
    const rows = [row({ branch: "B1" })];
    expect(
      capacityBookings(
        base({ rows, doctors: [doctor({ branches: ["B1", "B2"] })] }),
      ).bySpecialist.get("S1"),
    ).toEqual({ kind: "none", reason: "branch_not_in_file" });
    expect(
      capacityBookings(
        base({ rows, doctors: [doctor({ branches: ["B1", null] })] }),
      ).bySpecialist.get("S1"),
    ).toEqual({ kind: "none", reason: "branch_unmapped" });
    // the chosen branch has no finance code: nothing can be told apart
    expect(
      capacityBookings(
        base({ rows, view: { allowed: null, branch: null, available: false } }),
      ).bySpecialist.get("S1"),
    ).toEqual({ kind: "none", reason: "branch_unmapped" });
  });

  it("an unlinked doctor is not linked, never 0", () => {
    const r = capacityBookings(base({ rows: [row({})], doctors: [doctor({ doctorKey: null })] }));
    expect(r.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "not_linked" });
    expect(NO_BOOKING_LABEL.not_linked).toMatch(/Not linked/);
  });

  it("a linked doctor in a covered branch with no appointments is a real zero", () => {
    const r = capacityBookings(base({ rows: [row({ doctorKey: "dr other" })] }));
    expect(r.bySpecialist.get("S1")).toMatchObject({
      kind: "figure",
      booked: 0,
      bookedHours: 0,
      bookedPct: 0,
    });
  });

  it("follows the branch rule: the chosen branch narrows, a restricted member never sees other branches", () => {
    const rows = [row({ branch: "B1", minutes: 60 }), row({ branch: "B2", minutes: 120 })];
    const chosen = capacityBookings(
      base({ rows, view: { allowed: ["B1", "B2"], branch: "B1", available: true } }),
    );
    expect(chosen.bySpecialist.get("S1")).toMatchObject({ booked: 1, bookedHours: 1 });
    const restricted = capacityBookings(
      base({
        rows,
        view: { allowed: ["B2"], branch: null, available: true },
        doctors: [doctor({ branches: ["B2"] })],
      }),
    );
    expect(restricted.bySpecialist.get("S1")).toMatchObject({ booked: 1, bookedHours: 2 });
  });

  it("appointments with an unmapped clinic: counted for an unrestricted member, withheld for a restricted one", () => {
    const rows = [row({ branch: "B1", minutes: 60 }), row({ branch: null, minutes: 60 })];
    const all = capacityBookings(base({ rows }));
    expect(all.bySpecialist.get("S1")).toMatchObject({ booked: 2, bookedHours: 2 });
    const restricted = capacityBookings(
      base({ rows, view: { allowed: ["B1"], branch: null, available: true } }),
    );
    expect(restricted.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "unknown_branch" });
  });

  it("blank hours when a booked appointment has no length; the counts stay", () => {
    const r = capacityBookings(base({ rows: [row({ minutes: 60 }), row({ minutes: null })] }));
    expect(r.bySpecialist.get("S1")).toMatchObject({
      kind: "figure",
      booked: 2,
      bookedHours: null,
      bookedPct: null,
      noDuration: 1,
    });
    expect(r.totals).toMatchObject({ doctors: 1, booked: 2, bookedPct: null });
  });

  it("no percentage without available hours; the total uses only doctors with both", () => {
    const r = capacityBookings(
      base({
        rows: [row({ minutes: 120 }), row({ doctorKey: "dr demo two", minutes: 60 })],
        doctors: [
          doctor(),
          doctor({ specialistId: "S2", doctorKey: "dr demo two", availableHours: 0 }),
        ],
      }),
    );
    expect(r.bySpecialist.get("S2")).toMatchObject({ booked: 1, bookedHours: 1, bookedPct: null });
    expect(r.totals).toEqual({
      doctors: 2,
      booked: 2,
      bookedHours: 2,
      availableHours: 10,
      bookedPct: 20,
    });
  });
});
