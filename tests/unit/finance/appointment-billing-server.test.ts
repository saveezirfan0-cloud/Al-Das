import { describe, expect, it } from "vitest";

import type { Capacity, CapacityScope } from "@/lib/capacity/server";
import { loadAppointmentBilling } from "@/lib/finance/appointment-billing-server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The loader over an in-memory stand-in for the database: which invoices are fetched, the branch rule, the days the
 * invoices cover, invoices outside the month that name one of the month's appointments, an invoice whose appointment is
 * in another month's file, credit notes, and that no PIN leaves the loader. Synthetic data only.
 */

type Row = Record<string, unknown>;

function fakeAdmin(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = [];
    let lo = 0;
    let hi = Infinity;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
      gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
      lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
      in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), q),
      not: (c: string, _op: string, v: unknown) => (preds.push((r) => r[c] !== v), q),
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

const capacity = {
  openDays: 26,
  openHoursPerDay: 10,
  report: { doctors: [{ specialistId: "S1", availableHours: 2 }] },
} as unknown as Capacity;

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
const appt = (id: string, date: string, status: string, over: Row = {}): Row => ({
  id: `r${++n}`,
  upload_id: "U1",
  appointment_id: id,
  appt_date: date,
  status,
  patient_pin: "9000001",
  doctor_key: "omar testdoc",
  doctor_name: "Dr. Omar Testdoc",
  clinic_name: "Clinic One",
  room: null,
  duration_min: 30,
  is_current: true,
  org_id: "org",
  ...over,
});
const invoice = (no: string, date: string, over: Row = {}): Row => ({
  id: `i-${no}`,
  org_id: "org",
  inv_display_number: no,
  appointment_id: null,
  patient_pin: "9000009",
  doctor_name: "Dr. Omar Testdoc",
  transaction_date: date,
  branch_code: "B1",
  net: 100,
  is_deleted: false,
  ...over,
});

const base = (extra: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  fin_ref_branches: branches.map((b) => ({ ...b, org_id: "org" })),
  fin_appt_uploads: [{ id: "U1", from_date: "2026-09-01", to_date: "2026-09-30" }],
  specialists: [{ id: "S1", org_id: "org", report_doctor_key: "omar testdoc" }],
  rooms: [{ id: "R1", org_id: "org", name: "Room 1", location_id: "L1", active: true }],
  fin_appt_rows: [],
  fin_invoices: [],
  ...extra,
});

const load = (tables: Record<string, Row[]>, s = scope()) =>
  loadAppointmentBilling(fakeAdmin(tables), "org", s, "2026-09-01", capacity);

describe("loadAppointmentBilling", () => {
  it("lists seen-not-billed, billed-not-seen and the review items, and never returns a PIN", async () => {
    const r = await load(
      base({
        fin_appt_rows: [
          appt("1", "2026-09-10", "honoured"),
          appt("2", "2026-09-10", "honoured"), // no invoice
          appt("3", "2026-09-11", "cancelled"), // cancelled, no invoice: nothing
          appt("4", "2026-09-11", "cancelled"), // cancelled but invoiced
          appt("5", "2026-09-12", "honoured", { appointment_id: "5" }),
          appt("5", "2026-09-12", "honoured", { appointment_id: "5" }), // duplicate id
        ],
        fin_invoices: [
          invoice("I1", "2026-09-10", { appointment_id: "1" }),
          invoice("I4", "2026-09-11", { appointment_id: "4" }),
          invoice("I9", "2026-09-12", { appointment_id: "999" }), // not in any file
          invoice("D1", "2026-09-12"), // direct invoice: valid, never listed
          invoice("CN", "2026-09-12", { appointment_id: "2", net: -50 }), // credit note: not a bill
        ],
      }),
    );
    expect(r.seenNotBilled.map((l) => l.appointmentId)).toEqual(["2"]);
    expect(r.billedNotSeen.map((l) => [l.appointmentId, l.invoiceNos])).toEqual([["4", ["I4"]]]);
    expect(r.review.map((l) => l.reason)).toEqual([
      "duplicate_appointment_id",
      "duplicate_appointment_id",
    ]);
    expect(r.invoicesNotInFile.map((i) => i.invoiceNo)).toEqual(["I9"]);
    expect(r.counts).toMatchObject({
      seen_billed: 1,
      seen_not_billed: 1,
      billed_not_seen: 1,
      cancelled: 1,
      review: 2,
      total: 6,
    });
    expect(JSON.stringify(r)).not.toContain("9000001");
    expect(JSON.stringify(r)).not.toContain("9000009");
    expect(r.invoiceWindow).toEqual({ from: "2026-09-10", to: "2026-09-12" });
  });

  it("finds an invoice dated the next month that names a September appointment", async () => {
    const r = await load(
      base({
        fin_appt_rows: [appt("1", "2026-09-30", "honoured")],
        fin_invoices: [
          invoice("I0", "2026-09-30"), // makes the window cover the 30th
          invoice("I1", "2026-10-01", { appointment_id: "1" }),
        ],
      }),
    );
    expect(r.counts.seen_billed).toBe(1);
    expect(r.seenNotBilled).toEqual([]);
  });

  it("an invoice whose appointment is in another month's file is not reported missing", async () => {
    const r = await load(
      base({
        fin_appt_rows: [appt("1", "2026-09-10", "honoured"), appt("OCT", "2026-10-02", "honoured")],
        fin_invoices: [
          invoice("I1", "2026-09-10", { appointment_id: "1" }),
          invoice("I2", "2026-09-20", { appointment_id: "OCT" }),
        ],
      }),
    );
    expect(r.invoicesNotInFile).toEqual([]);
  });

  it("with no invoices in the month nothing is judged as not billed", async () => {
    const r = await load(base({ fin_appt_rows: [appt("1", "2026-09-10", "honoured")] }));
    expect(r.invoiceWindow).toBeNull();
    expect(r.counts).toMatchObject({ seen_not_billed: 0, not_judged: 1 });
  });

  it("days outside the invoice window are not judged", async () => {
    const r = await load(
      base({
        fin_appt_rows: [appt("1", "2026-09-02", "honoured"), appt("2", "2026-09-20", "honoured")],
        fin_invoices: [invoice("D1", "2026-09-15"), invoice("D2", "2026-09-25")],
      }),
    );
    expect(r.seenNotBilled.map((l) => l.appointmentId)).toEqual(["2"]);
    expect(r.counts.not_judged).toBe(1);
  });

  it("applies the branch rule: a restricted member sees their branch only, the unknown branch is for the unrestricted", async () => {
    const tables = base({
      fin_appt_rows: [
        appt("1", "2026-09-10", "honoured"),
        appt("2", "2026-09-10", "honoured", { clinic_name: "Clinic Two Renamed" }),
        appt("3", "2026-09-10", "honoured", { clinic_name: "Somewhere else" }),
        appt("4", "2026-09-10", "honoured", { clinic_name: null }),
      ],
      fin_invoices: [invoice("D1", "2026-09-10")],
    });
    const ids = (r: Awaited<ReturnType<typeof load>>) =>
      r.seenNotBilled.map((l) => l.appointmentId);
    expect(ids(await load(tables))).toEqual(["1", "2", "3", "4"]);
    expect((await load(tables)).unknownBranchRows).toBe(2);
    expect(ids(await load(tables, scope({ allowedCodes: ["B2"] })))).toEqual(["2"]);
    expect(
      ids(
        await load(
          tables,
          scope({ allowedCodes: ["B1", "B2"], chosen: "L1", revenueBranch: "B1" }),
        ),
      ),
    ).toEqual(["1"]);
    // a chosen branch with no finance code shows nothing and says so
    expect(
      ids(
        await load(tables, scope({ chosen: "L2", revenueBranch: null, revenueAvailable: false })),
      ),
    ).toEqual([]);
  });

  it("a restricted member's invoices outside their branches are not listed, though they still settle an appointment", async () => {
    const tables = base({
      fin_appt_rows: [appt("1", "2026-09-10", "honoured")],
      fin_invoices: [
        invoice("I1", "2026-09-10", { appointment_id: "1", branch_code: "B2" }), // invoiced at the other branch
        invoice("X1", "2026-09-10", { appointment_id: "777", branch_code: "B2" }),
      ],
    });
    const r = await load(tables, scope({ allowedCodes: ["B1"] }));
    expect(r.counts.seen_billed).toBe(1);
    expect(r.invoicesNotInFile).toEqual([]);
  });

  it("utilisation: available hours through the doctor link, rooms against open hours", async () => {
    const r = await load(
      base({
        fin_appt_rows: [
          appt("1", "2026-09-10", "honoured", { duration_min: 60, room: "room 1" }),
          appt("2", "2026-09-10", "cancelled", { duration_min: 30 }),
          appt("3", "2026-09-10", "confirmed", { duration_min: 30 }),
        ],
        fin_invoices: [invoice("D1", "2026-09-10")],
      }),
    );
    expect(r.doctors).toHaveLength(1);
    expect(r.doctors[0]).toMatchObject({
      booked: 2,
      seen: 1,
      cancelled: 1,
      bookedHours: 1.5,
      availableHours: 2,
      bookedPct: 75,
      seenPct: 50,
    });
    expect(r.hasRooms).toBe(true);
    // Room 1 of branch B1: 26 open days x 10 h = 260 h
    expect(r.rooms[0]).toMatchObject({
      branch: "B1",
      booked: 1,
      bookedHours: 1,
      availableHours: 260,
    });
    expect(r.doctorsWithoutHours).toBe(0);
  });

  it("a doctor with no link has hours but no percentage", async () => {
    const r = await load(
      base({
        fin_appt_rows: [
          appt("1", "2026-09-10", "honoured", {
            doctor_key: "lina testdoc",
            doctor_name: "Dr. Lina",
          }),
        ],
        fin_invoices: [invoice("D1", "2026-09-10")],
      }),
    );
    expect(r.doctors[0]).toMatchObject({ availableHours: null, bookedPct: null, bookedHours: 0.5 });
    expect(r.doctorsWithoutHours).toBe(1);
  });

  it("matches a direct invoice by PIN, doctor and day", async () => {
    const r = await load(
      base({
        fin_appt_rows: [appt("1", "2026-09-10", "honoured")],
        fin_invoices: [invoice("D1", "2026-09-10", { patient_pin: "9000001" })],
      }),
    );
    expect(r.counts.seen_billed).toBe(1);
  });

  it("coverage joins the uploads that still hold current rows", async () => {
    const r = await load(
      base({
        fin_appt_uploads: [
          { id: "U1", from_date: "2026-08-25", to_date: "2026-09-15" },
          { id: "U2", from_date: "2026-09-16", to_date: "2026-10-05" },
        ],
        fin_appt_rows: [
          appt("1", "2026-09-10", "honoured"),
          appt("2", "2026-09-20", "honoured", { upload_id: "U2" }),
        ],
      }),
    );
    expect(r.coverage.full).toBe(true);
  });
});

describe("importAppointmentFile", () => {
  it("stores only sanitised rows, passes the sha256, and reports unmapped clinics by name", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const admin = {
      ...(fakeAdmin(base()) as unknown as object),
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: { upload_id: "u1", existing: false, rows: 2, superseded: 0 }, error: null };
      },
    } as unknown as AdminClient;
    const { buildAppointmentWorkbook, DEFAULT_ROWS, SENTINELS } =
      await import("./fixtures/appointment-workbook");
    const { importAppointmentFile } = await import("@/lib/finance/appointment-billing-server");
    const buffer = await buildAppointmentWorkbook(DEFAULT_ROWS.slice(0, 2));
    const out = await importAppointmentFile(admin, { orgId: "org", userId: "user", buffer });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary).toMatchObject({
      uploadId: "u1",
      rows: 2,
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
    });
    expect(out.summary.unmappedClinics).toEqual(["Al Das Synthetic Clinic One"]); // not in the fake branch mapping
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("fin_appt_import");
    expect(String((calls[0].args.p_meta as { file_sha256: string }).file_sha256)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const sent = JSON.stringify(calls[0].args);
    for (const s of Object.values(SENTINELS)) expect(sent).not.toContain(s);
  });

  it("refuses a file it cannot trust without calling the database", async () => {
    let called = false;
    const admin = {
      rpc: async () => ((called = true), { data: null, error: null }),
    } as unknown as AdminClient;
    const { buildAppointmentWorkbook, DEFAULT_ROWS } =
      await import("./fixtures/appointment-workbook");
    const { importAppointmentFile } = await import("@/lib/finance/appointment-billing-server");
    const buffer = await buildAppointmentWorkbook(DEFAULT_ROWS, { headers: ["A", "B", "C"] });
    const out = await importAppointmentFile(admin, { orgId: "org", userId: "user", buffer });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});
