import { describe, expect, it } from "vitest";

import type { Capacity, CapacityScope } from "@/lib/capacity/server";
import { loadCapacityBookings } from "@/lib/finance/capacity-appointments-server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The Capacity page's booked-against-available loader over an in-memory stand-in for the database: the month and its
 * coverage, the clinic -> branch mapping (long name or alias), the doctor link, the branch rule, and that the PIN is
 * never read. Synthetic data only.
 */

type Row = Record<string, unknown>;

function fakeAdmin(tables: Record<string, Row[]>, selects: string[] = []) {
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = [];
    let lo = 0;
    let hi = Infinity;
    const q = {
      select: (cols: string) => (selects.push(`${table}:${cols}`), q),
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
      gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
      lte: (c: string, v: string) => (preds.push((r) => String(r[c]) <= v), q),
      lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
      in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), q),
      order: () => q,
      limit: () => q,
      range: (a: number, b: number) => ((lo = a), (hi = b), q),
      then: (resolve: (v: unknown) => unknown) => {
        const data = (tables[table] ?? [])
          .filter((r) => preds.every((p) => p(r)))
          .slice(lo, hi + 1);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { from } as unknown as AdminClient;
}

const scope = (over: Partial<CapacityScope> = {}): CapacityScope => ({
  locations: [
    { id: "L1", name: "Clinic One", timezone: "Asia/Dubai", branchCode: "B1" },
    { id: "L2", name: "Clinic Two", timezone: "Asia/Dubai", branchCode: "B2" },
  ],
  chosen: null,
  scopeIds: ["L1", "L2"],
  allowedCodes: null,
  revenueBranch: null,
  revenueAvailable: true,
  ...over,
});

const capacity = (doctorScope: Capacity["doctorScope"]): Capacity =>
  ({
    month: "2026-09-01",
    openDays: 26,
    openHoursPerDay: 10,
    report: {
      doctors: [
        { specialistId: "S1", availableHours: 4 },
        { specialistId: "S2", availableHours: 8 },
      ],
    },
    doctorScope,
  }) as unknown as Capacity;

const branches = [
  { code: "B1", name: "One", unite_clinic_long_name: "Clinic One", unite_clinic_aliases: [] },
  {
    code: "B2",
    name: "Two",
    unite_clinic_long_name: "Clinic Two",
    unite_clinic_aliases: ["Clinic Two Renamed"],
  },
];

let n = 0;
const appt = (over: Row = {}): Row => ({
  id: `r${++n}`,
  upload_id: "U1",
  appointment_id: `A${n}`,
  appt_date: "2026-09-10",
  status: "honoured",
  patient_pin: "9000001",
  doctor_key: "omar testdoc",
  doctor_name: "Dr. Omar Testdoc",
  clinic_name: "Clinic One",
  room: null,
  duration_min: 60,
  is_current: true,
  org_id: "org",
  ...over,
});

const tables = (extra: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  fin_ref_branches: branches.map((b) => ({ ...b, org_id: "org" })),
  fin_appt_uploads: [{ id: "U1", from_date: "2026-08-25", to_date: "2026-10-03" }],
  fin_appt_rows: [],
  ...extra,
});

const SCOPE = {
  S1: { doctorKey: "omar testdoc", locationIds: ["L1"] },
  S2: { doctorKey: null, locationIds: ["L2"] },
};

describe("loadCapacityBookings", () => {
  it("fills the column from the month's current rows, through the doctor link, and never reads the PIN", async () => {
    const selects: string[] = [];
    const r = await loadCapacityBookings(
      fakeAdmin(
        tables({
          fin_appt_rows: [
            appt({}),
            appt({ status: "cancelled" }),
            appt({ appt_date: "2026-10-01" }), // next month
            appt({ is_current: false }), // superseded
            appt({ clinic_name: "Clinic Two Renamed", doctor_key: "someone else" }),
          ],
        }),
        selects,
      ),
      "org",
      scope(),
      capacity(SCOPE),
    );
    expect(r.coverage.full).toBe(true);
    expect(r.bySpecialist.get("S1")).toMatchObject({
      kind: "figure",
      booked: 1,
      cancelled: 1,
      bookedHours: 1,
      bookedPct: 25,
    });
    expect(r.bySpecialist.get("S2")).toEqual({ kind: "none", reason: "not_linked" });
    expect(selects.some((s) => s.includes("patient_pin"))).toBe(false);
    expect(JSON.stringify([...r.bySpecialist.values()])).not.toContain("9000001");
  });

  it("keeps the no-data wording when the uploads cover part of the month", async () => {
    const r = await loadCapacityBookings(
      fakeAdmin(
        tables({
          fin_appt_uploads: [{ id: "U1", from_date: "2026-09-01", to_date: "2026-09-14" }],
          fin_appt_rows: [appt({})],
        }),
      ),
      "org",
      scope(),
      capacity(SCOPE),
    );
    expect(r.coverage.full).toBe(false);
    expect(r.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "part_month" });
    expect(r.totals.bookedPct).toBeNull();
  });

  it("no rows: no upload", async () => {
    const r = await loadCapacityBookings(fakeAdmin(tables()), "org", scope(), capacity(SCOPE));
    expect(r.hasRows).toBe(false);
    expect(r.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "no_upload" });
  });

  it("a doctor working at a branch the file does not hold gets no figure", async () => {
    const r = await loadCapacityBookings(
      fakeAdmin(tables({ fin_appt_rows: [appt({})] })),
      "org",
      scope(),
      capacity({ S1: { doctorKey: "omar testdoc", locationIds: ["L1", "L2"] } }),
    );
    expect(r.bySpecialist.get("S1")).toEqual({ kind: "none", reason: "branch_not_in_file" });
  });

  it("a chosen branch counts only its own appointments", async () => {
    const r = await loadCapacityBookings(
      fakeAdmin(
        tables({
          fin_appt_rows: [appt({}), appt({ clinic_name: "Clinic Two", duration_min: 120 })],
        }),
      ),
      "org",
      scope({ chosen: "L2", scopeIds: ["L2"], revenueBranch: "B2" }),
      capacity({ S1: { doctorKey: "omar testdoc", locationIds: ["L2"] } }),
    );
    expect(r.bySpecialist.get("S1")).toMatchObject({ kind: "figure", booked: 1, bookedHours: 2 });
  });
});
