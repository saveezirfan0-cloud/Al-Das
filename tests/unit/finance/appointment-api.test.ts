import { describe, expect, it } from "vitest";

import type { AppointmentStatus } from "@/lib/appointments/status";
import {
  daysToSettle,
  finishedDays,
  mergeSettled,
  settledOf,
  uniteDayRows,
  W2_STATUS,
  type SyncedAppointment,
} from "@/lib/finance/appointment-api";

const TZ = "Asia/Dubai";
const statusMap = new Map<string, AppointmentStatus | null>([
  ["ACF", "confirmed"],
  ["CNR", "cancelled"],
  ["DONE", "completed"],
  ["NSW", "no_show"],
  ["YTC", "awaiting"],
  ["CVI", null],
]);

function appt(over: Partial<SyncedAppointment> = {}): SyncedAppointment {
  return {
    externalId: "A-1",
    // 10:00 to 10:30 in Dubai on 2026-10-21
    startsAt: "2026-10-21T06:00:00.000Z",
    endsAt: "2026-10-21T06:30:00.000Z",
    externalStatus: "DONE",
    endGiven: true,
    patientPin: "PIN-SYN-1",
    doctorName: "Dr Alex Example",
    clinicName: "Synthetic Clinic One",
    ...over,
  };
}

describe("uniteDayRows", () => {
  it("builds the same row shape a file gives, in appointment id order", () => {
    const r = uniteDayRows([appt({ externalId: "B-2", externalStatus: "acf" }), appt()], {
      day: "2026-10-21",
      timezone: TZ,
      statusMap,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.appointment_id)).toEqual(["A-1", "B-2"]);
    expect(r.rows[0]).toEqual({
      row_no: 1,
      appointment_id: "A-1",
      appt_date: "2026-10-21",
      start_min: 600,
      duration_min: 30,
      status: "honoured",
      patient_pin: "PIN-SYN-1",
      doctor_name: "Dr Alex Example",
      doctor_key: expect.any(String),
      clinic_name: "Synthetic Clinic One",
      room: null,
    });
    expect(r.rows[1].status).toBe("confirmed");
    expect(r.rows[1].row_no).toBe(2);
  });

  it("maps every Pulse status, a no-show as booked and not seen", () => {
    expect(W2_STATUS).toEqual({
      awaiting: "awaiting",
      confirmed: "confirmed",
      completed: "honoured",
      cancelled: "cancelled",
      no_show: "confirmed",
    });
  });

  it("never reads the default length as a real one", () => {
    const r = uniteDayRows([appt({ endGiven: false })], {
      day: "2026-10-21",
      timezone: TZ,
      statusMap,
    });
    expect(r.ok && r.rows[0].duration_min).toBeNull();
  });

  it("only takes appointments that start on the day in the clinic's time zone", () => {
    const late = appt({
      externalId: "L",
      startsAt: "2026-10-21T20:30:00.000Z",
      endsAt: "2026-10-21T21:00:00.000Z",
    });
    const r = uniteDayRows([appt(), late], { day: "2026-10-21", timezone: TZ, statusMap });
    // 00:30 on the 22nd in Dubai
    expect(r.ok && r.rows.map((x) => x.appointment_id)).toEqual(["A-1"]);
  });

  it("holds the whole day when a status code has no meaning yet, listing the codes only", () => {
    const r = uniteDayRows(
      [
        appt(),
        appt({ externalId: "X", externalStatus: "CVI" }),
        appt({ externalId: "Y", externalStatus: "ZZZ" }),
      ],
      { day: "2026-10-21", timezone: TZ, statusMap },
    );
    expect(r).toEqual({ ok: false, reason: "unmapped_status", codes: ["CVI", "ZZZ"] });
  });

  it("holds the day for a blank status and keeps a missing doctor as the no-doctor key", () => {
    expect(
      uniteDayRows([appt({ externalStatus: null })], {
        day: "2026-10-21",
        timezone: TZ,
        statusMap,
      }),
    ).toEqual({ ok: false, reason: "unmapped_status", codes: ["(blank)"] });
    const r = uniteDayRows([appt({ doctorName: "  " })], {
      day: "2026-10-21",
      timezone: TZ,
      statusMap,
    });
    expect(r.ok && r.rows[0].doctor_name).toBeTruthy();
    expect(r.ok && r.rows[0].doctor_key).toBeTruthy();
  });
});

describe("settled days", () => {
  // 01:00 on 23 Oct in Dubai
  const now = new Date("2026-10-22T21:00:00.000Z");

  it("lists the last week of finished days, oldest first, never today", () => {
    expect(finishedDays(now, TZ, 3)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(finishedDays(now, TZ)).toHaveLength(7);
    expect(finishedDays(now, TZ)).not.toContain("2026-10-23");
  });

  it("settles only what is not settled yet", () => {
    expect(daysToSettle(now, TZ, [], 3)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(daysToSettle(now, TZ, ["2026-10-20", "2026-10-22"], 3)).toEqual(["2026-10-21"]);
    expect(daysToSettle(now, TZ, ["2026-10-20", "2026-10-21", "2026-10-22"], 3)).toEqual([]);
  });

  it("keeps a sorted, de-duplicated list of the newest days and reads a cursor defensively", () => {
    expect(
      mergeSettled(["2026-10-02", "2026-10-01"], ["2026-10-02", "2026-10-03", "bad"], 2),
    ).toEqual(["2026-10-02", "2026-10-03"]);
    expect(settledOf({ settled: ["2026-10-01", 5] })).toEqual(["2026-10-01"]);
    expect(settledOf(null)).toEqual([]);
    expect(settledOf({ settled: "2026-10-01" })).toEqual([]);
    expect(settledOf([])).toEqual([]);
  });
});
