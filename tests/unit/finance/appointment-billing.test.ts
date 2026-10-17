import { describe, expect, it } from "vitest";

import {
  branchOfClinic,
  branchVisible,
  countVerdicts,
  doctorUtilisation,
  matchAppointments,
  mergeRanges,
  roomUtilisation,
  type ApptIn,
  type InvoiceIn,
} from "@/lib/finance/appointment-billing";

const WINDOW = { from: "2026-09-01", to: "2026-09-30" };

let n = 0;
const appt = (o: Partial<ApptIn> & { appointmentId: string }): ApptIn => ({
  id: `row-${++n}`,
  date: "2026-09-10",
  status: "honoured",
  pin: null,
  doctorKey: "omar testdoc",
  doctorName: "Dr. Omar Testdoc",
  branch: "B1",
  room: null,
  minutes: 30,
  ...o,
});
const inv = (o: Partial<InvoiceIn> & { invoiceNo: string }): InvoiceIn => ({
  id: `inv-${o.invoiceNo}`,
  appointmentId: null,
  pin: null,
  doctorKey: "omar testdoc",
  date: "2026-09-10",
  branch: "B1",
  ...o,
});
const verdicts = (a: ApptIn[], i: InvoiceIn[], w = WINDOW) =>
  Object.fromEntries(
    matchAppointments(a, i, w).appointments.map((r) => [r.appointmentId, r.verdict]),
  );

describe("status rule", () => {
  it("honoured with an invoice is seen and billed; without one it is seen, not billed", () => {
    const v = verdicts(
      [appt({ appointmentId: "1" }), appt({ appointmentId: "2" })],
      [inv({ invoiceNo: "I1", appointmentId: "1" })],
    );
    expect(v).toEqual({ "1": "seen_billed", "2": "seen_not_billed" });
  });

  it("a cancelled appointment with no invoice is NOT seen-not-billed", () => {
    expect(verdicts([appt({ appointmentId: "1", status: "cancelled" })], [])).toEqual({
      "1": "cancelled",
    });
  });

  it("confirmed and awaiting without an invoice are open, not exceptions", () => {
    expect(
      verdicts(
        [
          appt({ appointmentId: "1", status: "confirmed" }),
          appt({ appointmentId: "2", status: "awaiting" }),
        ],
        [],
      ),
    ).toEqual({ "1": "open", "2": "open" });
  });

  it("an invoice on an appointment that is not honoured is billed, not seen", () => {
    const v = verdicts(
      [
        appt({ appointmentId: "1", status: "cancelled" }),
        appt({ appointmentId: "2", status: "confirmed" }),
        appt({ appointmentId: "3", status: "awaiting" }),
      ],
      [1, 2, 3].map((k) => inv({ invoiceNo: `I${k}`, appointmentId: String(k) })),
    );
    expect(v).toEqual({ "1": "billed_not_seen", "2": "billed_not_seen", "3": "billed_not_seen" });
  });

  it("an appointment can carry two invoices (self-pay and insurance)", () => {
    const r = matchAppointments(
      [appt({ appointmentId: "1" })],
      [inv({ invoiceNo: "I2", appointmentId: "1" }), inv({ invoiceNo: "I1", appointmentId: "1" })],
      WINDOW,
    );
    expect(r.appointments[0]).toMatchObject({
      verdict: "seen_billed",
      basis: "appointment_id",
      invoiceNos: ["I1", "I2"],
    });
  });
});

describe("invoice side", () => {
  it("a direct invoice (no appointment id) is never billed-not-seen and never listed", () => {
    const r = matchAppointments(
      [appt({ appointmentId: "1" })],
      [
        inv({ invoiceNo: "D1", appointmentId: null }),
        inv({ invoiceNo: "D2", appointmentId: "  " }),
      ],
      WINDOW,
    );
    expect(r.invoicesNotInFile).toEqual([]);
    expect(r.appointments[0].verdict).toBe("seen_not_billed");
  });

  it("an invoice naming an appointment the file does not hold is listed for review", () => {
    const r = matchAppointments(
      [appt({ appointmentId: "1" })],
      [inv({ invoiceNo: "I9", appointmentId: "999" })],
      WINDOW,
    );
    expect(r.invoicesNotInFile.map((i) => i.invoiceNo)).toEqual(["I9"]);
  });

  it("ids are compared exactly after trimming", () => {
    const v = verdicts(
      [appt({ appointmentId: " 12 " })],
      [inv({ invoiceNo: "I1", appointmentId: "12" })],
    );
    expect(v).toEqual({ " 12 ": "seen_billed" });
  });
});

describe("matching by PIN, doctor and day (fallback)", () => {
  const a = (extra: Partial<ApptIn> = {}) => appt({ appointmentId: "1", pin: "9000001", ...extra });
  const direct = (extra: Partial<InvoiceIn> = {}) =>
    inv({ invoiceNo: "D1", pin: "9000001", ...extra });

  it("ties a direct invoice to the one appointment with the same PIN, doctor and day", () => {
    const r = matchAppointments([a()], [direct()], WINDOW);
    expect(r.appointments[0]).toMatchObject({
      verdict: "seen_billed",
      basis: "pin_doctor_day",
      invoiceNos: ["D1"],
    });
  });

  it("does not match another doctor, another day or another PIN", () => {
    for (const other of [{ doctorKey: "lina testdoc" }, { date: "2026-09-11" }, { pin: "9000002" }])
      expect(
        matchAppointments([a()], [direct(other)], WINDOW).appointments[0].verdict,
        JSON.stringify(other),
      ).toBe("seen_not_billed");
  });

  it("an appointment id match wins; the fallback is not used", () => {
    const r = matchAppointments(
      [a()],
      [inv({ invoiceNo: "I1", appointmentId: "1" }), direct()],
      WINDOW,
    );
    expect(r.appointments[0]).toMatchObject({ basis: "appointment_id", invoiceNos: ["I1"] });
  });

  it("is never guessed when two live appointments share PIN, doctor and day", () => {
    const r = matchAppointments([a(), a({ appointmentId: "2" })], [direct()], WINDOW);
    expect(r.appointments.map((x) => [x.verdict, x.reason])).toEqual([
      ["review", "ambiguous_pin_doctor_day"],
      ["review", "ambiguous_pin_doctor_day"],
    ]);
  });

  it("a cancelled twin does not make it ambiguous, and a cancelled appointment never takes the invoice", () => {
    const r = matchAppointments(
      [a(), a({ appointmentId: "2", status: "cancelled" })],
      [direct()],
      WINDOW,
    );
    expect(r.appointments.map((x) => x.verdict)).toEqual(["seen_billed", "cancelled"]);
  });

  it("is skipped without a PIN or a doctor", () => {
    expect(
      matchAppointments([a({ pin: null })], [direct({ pin: null })], WINDOW).appointments[0]
        .verdict,
    ).toBe("seen_not_billed");
    expect(
      matchAppointments(
        [a({ doctorKey: "(no doctor)" })],
        [direct({ doctorKey: "(no doctor)" })],
        WINDOW,
      ).appointments[0].verdict,
    ).toBe("seen_not_billed");
  });

  it("with no candidate invoice, two live appointments are simply not billed", () => {
    expect(verdicts([a(), a({ appointmentId: "2" })], [])).toEqual({
      "1": "seen_not_billed",
      "2": "seen_not_billed",
    });
  });
});

describe("duplicates and coverage", () => {
  it("an appointment id that appears twice is listed for review, with its invoice not reported as missing", () => {
    const r = matchAppointments(
      [appt({ appointmentId: "1" }), appt({ appointmentId: "1" })],
      [inv({ invoiceNo: "I1", appointmentId: "1" })],
      WINDOW,
    );
    expect(r.appointments.map((x) => [x.verdict, x.reason])).toEqual([
      ["review", "duplicate_appointment_id"],
      ["review", "duplicate_appointment_id"],
    ]);
    expect(r.invoicesNotInFile).toEqual([]);
  });

  it("outside the dates the invoices cover, an unbilled honoured appointment is not judged", () => {
    const v = verdicts(
      [
        appt({ appointmentId: "1", date: "2026-09-01" }),
        appt({ appointmentId: "2", date: "2026-09-20" }),
      ],
      [],
      { from: "2026-09-10", to: "2026-09-30" },
    );
    expect(v).toEqual({ "1": "not_judged", "2": "seen_not_billed" });
  });

  it("with no invoice data at all nothing is judged as not billed", () => {
    expect(verdicts([appt({ appointmentId: "1" })], [], null as never)).toEqual({
      "1": "not_judged",
    });
  });

  it("an invoice settles an appointment even outside the covered dates", () => {
    expect(
      verdicts(
        [appt({ appointmentId: "1", date: "2026-09-01" })],
        [inv({ invoiceNo: "I1", appointmentId: "1" })],
        {
          from: "2026-09-10",
          to: "2026-09-30",
        },
      ),
    ).toEqual({ "1": "seen_billed" });
  });

  it("counts every verdict once", () => {
    const r = matchAppointments(
      [
        appt({ appointmentId: "1" }),
        appt({ appointmentId: "2" }),
        appt({ appointmentId: "3", status: "cancelled" }),
      ],
      [inv({ invoiceNo: "I1", appointmentId: "1" })],
      WINDOW,
    );
    expect(countVerdicts(r.appointments)).toMatchObject({
      seen_billed: 1,
      seen_not_billed: 1,
      cancelled: 1,
      total: 3,
    });
  });

  it("is deterministic: the order of the inputs does not change the answer", () => {
    const A = [
      appt({ appointmentId: "1", pin: "9000001" }),
      appt({ appointmentId: "2", pin: "9000001" }),
      appt({ appointmentId: "3" }),
    ];
    const I = [
      inv({ invoiceNo: "D1", pin: "9000001" }),
      inv({ invoiceNo: "I3", appointmentId: "3" }),
    ];
    const a = matchAppointments(A, I, WINDOW);
    const b = matchAppointments([...A].reverse(), [...I].reverse(), WINDOW);
    const key = (r: typeof a) =>
      r.appointments.map((x) => `${x.appointmentId}:${x.verdict}`).sort();
    expect(key(b)).toEqual(key(a));
  });
});

describe("utilisation", () => {
  const list = [
    appt({ appointmentId: "1", minutes: 30 }),
    appt({ appointmentId: "2", minutes: 30, status: "confirmed" }),
    appt({ appointmentId: "3", minutes: 60, status: "cancelled" }),
    appt({
      appointmentId: "4",
      minutes: 30,
      doctorKey: "lina testdoc",
      doctorName: "Dr. Lina Testdoc",
    }),
  ];

  it("per doctor: booked excludes cancelled; seen is honoured; percentages against available hours", () => {
    const u = doctorUtilisation(list, (k) => (k === "omar testdoc" ? 2 : null));
    expect(u[1]).toMatchObject({
      name: "Dr. Omar Testdoc",
      booked: 2,
      seen: 1,
      cancelled: 1,
      bookedHours: 1,
      seenHours: 0.5,
      availableHours: 2,
      bookedPct: 50,
      seenPct: 25,
    });
    // a doctor with no available hours known has hours but no percentage
    expect(u[0]).toMatchObject({
      name: "Dr. Lina Testdoc",
      bookedHours: 0.5,
      availableHours: null,
      bookedPct: null,
    });
  });

  it("is unknown (never zero) when a booked appointment has no duration", () => {
    const u = doctorUtilisation(
      [appt({ appointmentId: "1", minutes: null }), appt({ appointmentId: "2", minutes: 30 })],
      () => 10,
    );
    expect(u[0]).toMatchObject({
      booked: 2,
      noDuration: 1,
      bookedHours: null,
      seenHours: null,
      bookedPct: null,
    });
  });

  it("zero available hours gives no percentage", () => {
    expect(doctorUtilisation(list, () => 0)[0].bookedPct).toBeNull();
  });

  it("per room: grouped by branch and normalised name; rooms not in Rooms have no percentage", () => {
    const rooms = [
      appt({ appointmentId: "1", room: "Room 1", minutes: 60 }),
      appt({ appointmentId: "2", room: "room  1", minutes: 60 }),
      appt({ appointmentId: "5", room: "Room 1", minutes: 0, status: "cancelled" }),
      appt({ appointmentId: "6", room: "Room 1", minutes: 0, status: "cancelled" }),
      appt({ appointmentId: "3", room: "Room 1", branch: "B2", minutes: 30 }),
      appt({ appointmentId: "4", room: null }),
    ];
    const u = roomUtilisation(rooms, (branch, key) =>
      branch === "B1" && key === "room 1" ? 10 : null,
    );
    expect(u.map((r) => [r.branch, r.room, r.bookedHours, r.availableHours, r.bookedPct])).toEqual([
      ["B1", "Room 1", 2, 10, 20],
      ["B2", "Room 1", 0.5, null, null],
    ]);
  });
});

describe("branch and coverage helpers", () => {
  const branches = [
    {
      code: "B1",
      unite_clinic_long_name: "Al Das Synthetic Clinic One",
      unite_clinic_aliases: ["Al Das Renamed  Clinic"],
    },
    {
      code: "B2",
      unite_clinic_long_name: "Al Das Synthetic Clinic Two",
      unite_clinic_aliases: null,
    },
  ];
  it("maps a clinic by its long name or any alias, else unknown", () => {
    expect(branchOfClinic(" Al Das Synthetic Clinic One ", branches)).toBe("B1");
    expect(branchOfClinic("Al Das Renamed Clinic", branches)).toBe("B1");
    expect(branchOfClinic("al das synthetic clinic two", branches)).toBeNull(); // exact, as the SQL pages
    expect(branchOfClinic(null, branches)).toBeNull();
    expect(branchOfClinic("Somewhere else", branches)).toBeNull();
  });
  it("branch visibility: choice narrows, unknown only for the unrestricted", () => {
    const all = { allowed: null, branch: null, available: true };
    expect(branchVisible(all, null)).toBe(true);
    expect(branchVisible({ ...all, allowed: ["B1"] }, null)).toBe(false);
    expect(branchVisible({ ...all, allowed: ["B1"] }, "B2")).toBe(false);
    expect(branchVisible({ ...all, allowed: ["B1", "B2"] }, "B2")).toBe(true);
    expect(branchVisible({ ...all, branch: "B1" }, "B2")).toBe(false);
    expect(branchVisible({ ...all, branch: "B1" }, null)).toBe(false);
    expect(branchVisible({ ...all, available: false }, "B1")).toBe(false);
  });
  it("joins overlapping and touching ranges", () => {
    expect(
      mergeRanges([
        { from: "2026-09-10", to: "2026-09-20" },
        { from: "2026-09-01", to: "2026-09-09" },
        { from: "2026-09-25", to: "2026-09-30" },
      ]),
    ).toEqual([
      { from: "2026-09-01", to: "2026-09-20" },
      { from: "2026-09-25", to: "2026-09-30" },
    ]);
  });
});
