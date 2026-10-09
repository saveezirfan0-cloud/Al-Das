import { describe, expect, it } from "vitest";

import {
  mapAppointment,
  mapDoctor,
  mapPatient,
  parseUniteDate,
  parseUniteTime,
  pick,
} from "@/lib/unite/mappers";

const TZ = "Asia/Dubai"; // UTC+4

describe("parseUniteTime", () => {
  it("reads ISO local time in the clinic timezone", () => {
    expect(parseUniteTime("2026-10-12T09:30:00", TZ)?.toISOString()).toBe(
      "2026-10-12T05:30:00.000Z",
    );
    expect(parseUniteTime("2026-10-12 09:30", TZ)?.toISOString()).toBe("2026-10-12T05:30:00.000Z");
  });

  it("honours an explicit offset or Z", () => {
    expect(parseUniteTime("2026-10-12T09:30:00Z", TZ)?.toISOString()).toBe(
      "2026-10-12T09:30:00.000Z",
    );
    expect(parseUniteTime("2026-10-12T09:30:00+0200", TZ)?.toISOString()).toBe(
      "2026-10-12T07:30:00.000Z",
    );
  });

  it("reads day-first dates, never month-first", () => {
    expect(parseUniteTime("12-10-2026 09:30", TZ)?.toISOString()).toBe("2026-10-12T05:30:00.000Z");
    expect(parseUniteTime("12/10/2026 09:30:15", TZ)?.toISOString()).toBe(
      "2026-10-12T05:30:15.000Z",
    );
    // 13th can only be a day
    expect(parseUniteTime("13/10/2026", TZ)?.toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(parseUniteTime("10/13/2026 09:00", TZ)).toBeNull(); // would be month 13
  });

  it("understands AM/PM", () => {
    expect(parseUniteTime("12-10-2026 02:15 PM", TZ)?.toISOString()).toBe(
      "2026-10-12T10:15:00.000Z",
    );
    expect(parseUniteTime("12-10-2026 12:05 AM", TZ)?.toISOString()).toBe(
      "2026-10-11T20:05:00.000Z",
    );
    expect(parseUniteTime("12-10-2026 13:00 PM", TZ)).toBeNull();
  });

  it("rejects garbage and impossible dates", () => {
    for (const bad of [
      "",
      "soon",
      "2026-02-30T10:00:00",
      "31-04-2026 10:00",
      "2026-10-12T25:00:00",
      null,
      undefined,
    ])
      expect(parseUniteTime(bad as string, TZ)).toBeNull();
  });
});

describe("parseUniteDate", () => {
  it("returns the literal calendar date regardless of timezone", () => {
    expect(parseUniteDate("1990-10-10")).toBe("1990-10-10");
    expect(parseUniteDate("10-10-1990")).toBe("1990-10-10");
    expect(parseUniteDate("05/03/1985")).toBe("1985-03-05");
    expect(parseUniteDate("nope")).toBeNull();
  });
});

describe("pick", () => {
  it("is case-insensitive and skips blanks", () => {
    expect(pick({ DoctorName: " Dr X " }, "doctorname")).toBe("Dr X");
    expect(pick({ a: "", b: null, c: 7 }, "a", "b", "c")).toBe("7");
    expect(pick({}, "a")).toBeNull();
  });
});

describe("mapAppointment", () => {
  const raw = {
    appointmentid: 90001,
    appointmentstarttime: "12-10-2026 09:30",
    appointmentendtime: "12-10-2026 10:00",
    clinic_id: "DHA-F-0000000",
    createdby: "reception1",
    doctor_id: "DOC-1",
    doctorname: "Dr Alex Example",
    nationality: "AE",
    patientfullname: "Sara Example",
    patientmobilephone: "971-500000001",
    patientpin: "PIN-1",
    remarks: "First visit",
    status: "acf",
  };

  it("maps a full record", () => {
    const res = mapAppointment(raw, { timezone: TZ });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      externalId: "90001",
      clinicId: "DHA-F-0000000",
      doctorId: "DOC-1",
      doctorName: "Dr Alex Example",
      statusCode: "ACF",
      notes: "First visit",
      patient: { pin: "PIN-1", name: "Sara Example", phoneE164: "+971500000001" },
    });
    expect(res.value.startsAt.toISOString()).toBe("2026-10-12T05:30:00.000Z");
    expect(res.value.endsAt.toISOString()).toBe("2026-10-12T06:00:00.000Z");
  });

  it("defaults to 30 minutes when no end time is sent and falls back to the requested clinic", () => {
    const { appointmentendtime: _end, clinic_id: _c, ...rest } = raw;
    void _end;
    void _c;
    const res = mapAppointment(rest, { timezone: TZ, clinicId: "DHA-X" });
    expect(res.ok && res.value.endsAt.getTime() - res.value.startsAt.getTime()).toBe(30 * 60_000);
    expect(res.ok && res.value.clinicId).toBe("DHA-X");
  });

  it("reports why a record can't be used instead of guessing", () => {
    expect(mapAppointment({ ...raw, appointmentid: "" }, { timezone: TZ })).toEqual({
      ok: false,
      reason: "missing_id",
    });
    expect(mapAppointment({ ...raw, appointmentstarttime: "tomorrow" }, { timezone: TZ })).toEqual({
      ok: false,
      reason: "unparseable_time",
    });
    expect(
      mapAppointment({ ...raw, appointmentendtime: "12-10-2026 09:00" }, { timezone: TZ }),
    ).toEqual({
      ok: false,
      reason: "end_before_start",
    });
  });

  it("copes with a missing phone", () => {
    const res = mapAppointment({ ...raw, patientmobilephone: "" }, { timezone: TZ });
    expect(res.ok && res.value.patient.phoneE164).toBeNull();
  });
});

describe("doctor and patient mappers", () => {
  it("maps doctors with tolerant keys", () => {
    expect(mapDoctor({ DoctorId: "D9", DoctorName: "Dr Sam", Department: "Paediatrics" })).toEqual({
      externalId: "D9",
      name: "Dr Sam",
      department: "Paediatrics",
    });
    expect(mapDoctor({ doctor_id: "D9" })).toBeNull();
  });

  it("maps patients and splits the name", () => {
    expect(
      mapPatient(
        {
          patientpin: "P1",
          patientfullname: "Sara Anne Example",
          mobile: "050 000 0001",
          dob: "1990-10-10",
          gender: "Female",
        },
        { timezone: TZ },
      ),
    ).toMatchObject({
      pin: "P1",
      firstName: "Sara",
      lastName: "Anne Example",
      phoneE164: "+971500000001",
      dob: "1990-10-10",
      gender: "female",
    });
    expect(mapPatient({ patientpin: "P1" }, { timezone: TZ })).toBeNull();
  });
});
