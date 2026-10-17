import { describe, expect, it } from "vitest";

import { APPOINTMENT_FIELDS, headerToken } from "@/lib/finance/appointment-mapping";
import {
  parseAppointmentFile,
  parseAppointmentTable,
  previewAppointmentTable,
  readApptDate,
  readApptTime,
  readDuration,
  readStatus,
} from "@/lib/finance/parse-appointments";

import {
  buildAppointmentWorkbook,
  clock,
  DEFAULT_ROWS,
  HEADERS,
  SENTINELS,
  wall,
} from "./fixtures/appointment-workbook";

const H = ["Appointment ID", "Appointment Date", "Appointment Status", "Doctor Name"];

describe("parseAppointmentFile (synthetic workbook)", () => {
  it("reads rows, normalises doctors, derives durations and the date range", async () => {
    const r = await parseAppointmentFile(await buildAppointmentWorkbook());
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows).toHaveLength(5);
    expect(r.fromDate).toBe("2026-09-01");
    expect(r.toDate).toBe("2026-09-02");
    expect(r.rows[0]).toEqual({
      row_no: 1,
      appointment_id: "1001",
      appt_date: "2026-09-01",
      start_min: 540,
      duration_min: 30,
      status: "honoured",
      patient_pin: "9000001",
      doctor_name: "Dr. Omar Testdoc",
      doctor_key: "omar testdoc",
      clinic_name: "Al Das Synthetic Clinic One",
      room: "Room 1",
    });
    // two spellings of one doctor give one key
    expect(r.rows[1].doctor_key).toBe("omar testdoc");
    expect(r.rows.map((x) => x.status)).toEqual([
      "honoured",
      "honoured",
      "cancelled",
      "confirmed",
      "awaiting",
    ]);
    expect(r.rows[3].duration_min).toBe(60);
    expect(r.has).toEqual({ pin: true, clinic: true, room: true, duration: true });
  });

  it("never reads a column the mapping does not name", async () => {
    const r = await parseAppointmentFile(await buildAppointmentWorkbook());
    const text = JSON.stringify(r);
    for (const s of Object.values(SENTINELS)) expect(text).not.toContain(s);
  });

  it("finds the header below title lines and skips a total line", async () => {
    const r = await parseAppointmentFile(
      await buildAppointmentWorkbook(DEFAULT_ROWS, { titleLines: 3, footer: true }),
    );
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows).toHaveLength(5);
    expect(r.skipped).toBe(1);
  });

  it("refuses a file with an unknown header layout, naming fields and unrecognised headers only", async () => {
    const r = await parseAppointmentFile(
      await buildAppointmentWorkbook(DEFAULT_ROWS, {
        headers: HEADERS.map((h) => (h === "Appointment ID" ? "Booking Reference" : h)),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.join(" ")).toContain("Appointment ID");
    expect(r.unrecognised).toContain("Booking Reference");
    expect(r.unrecognised).toContain("Patient Name"); // the NAME of an ignored column is listed ...
    expect(JSON.stringify(r)).not.toContain(SENTINELS.name); // ... its values never are
  });

  it("refuses an ambiguous header (two columns for one field)", () => {
    const r = parseAppointmentTable([
      [...H, "Appt Status"],
      ["1", "14-Oct-2026", "Honoured", "Dr A", "Honoured"],
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0]).toContain("More than one column could be the Appointment status");
  });
});

describe("parseAppointmentTable", () => {
  it("refuses a status Pulse does not know, listing the words", () => {
    const r = parseAppointmentTable([
      H,
      ["1", "14-Oct-2026", "Checked In", "Dr A"],
      ["2", "14-Oct-2026", "Honoured", "Dr A"],
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain('"Checked In"');
  });

  it("reports bad rows by row number and field, never by value", () => {
    const r = parseAppointmentTable([
      H,
      ["", "14-Oct-2026", "Honoured", "Dr A"],
      ["2", "not a date SENTINEL-VALUE", "Honoured", "Dr A"],
      ["3", "14-Oct-2026", "", "Dr A"],
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      "Row 2: the Appointment ID is blank or not readable.",
      "Row 3: the Appointment date is blank or not a date.",
      "Row 4: the Appointment status is blank.",
    ]);
    expect(JSON.stringify(r)).not.toContain("SENTINEL-VALUE");
  });

  it("takes the start time from the date cell when there is no time column", () => {
    const r = parseAppointmentTable([
      H,
      ["1", wall(2026, 10, 14, 9, 30), "Honoured", "Dr A"],
      ["2", "14/10/2026 2:15 PM", "Honoured", "Dr A"],
    ]);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows.map((x) => [x.appt_date, x.start_min, x.duration_min])).toEqual([
      ["2026-10-14", 570, null],
      ["2026-10-14", 855, null],
    ]);
    expect(r.has.duration).toBe(false);
  });

  it("uses a duration column, and end minus start wins over it", () => {
    const r = parseAppointmentTable([
      [...H, "Start Time", "End Time", "Duration (Mins)"],
      ["1", "14-Oct-2026", "Honoured", "Dr A", "09:00", "09:45", 20],
      ["2", "14-Oct-2026", "Honoured", "Dr A", "09:00", null, "20 min"],
    ]);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows.map((x) => x.duration_min)).toEqual([45, 20]);
  });

  it("refuses an end time that is not after the start", () => {
    const r = parseAppointmentTable([
      [...H, "Start Time", "End Time"],
      ["1", "14-Oct-2026", "Honoured", "Dr A", "10:00", "09:00"],
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses a file whose dates span more than a year, and an empty file", () => {
    const span = parseAppointmentTable([
      H,
      ["1", "14-Oct-2024", "Honoured", "Dr A"],
      ["2", "14-Oct-2026", "Honoured", "Dr A"],
    ]);
    expect(span.ok).toBe(false);
    expect(parseAppointmentTable([H]).ok).toBe(false);
  });

  it("works without the optional columns", () => {
    const r = parseAppointmentTable([H, ["1", "14-Oct-2026", "Honoured", "Dr A"]]);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.has).toEqual({ pin: false, clinic: false, room: false, duration: false });
    expect(r.rows[0]).toMatchObject({
      patient_pin: null,
      clinic_name: null,
      room: null,
      start_min: null,
    });
  });

  it("keeps a blank doctor as the (no doctor) placeholder", () => {
    const r = parseAppointmentTable([H, ["1", "14-Oct-2026", "Honoured", null]]);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows[0]).toMatchObject({ doctor_name: "(no doctor)", doctor_key: "(no doctor)" });
  });

  it("reads a CSV-like table of text cells the same way", () => {
    const r = parseAppointmentTable([H, ["77", "2026-10-14", "awaiting  confirmation", "Dr. A"]]);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.rows[0]).toMatchObject({
      appointment_id: "77",
      appt_date: "2026-10-14",
      status: "awaiting",
    });
  });
});

describe("value readers", () => {
  it("dates", () => {
    expect(readApptDate("14-Oct-2026")).toEqual({ date: "2026-10-14", minutes: null });
    expect(readApptDate("14/10/2026")).toEqual({ date: "2026-10-14", minutes: null });
    expect(readApptDate("2026-10-14 09:05")).toEqual({ date: "2026-10-14", minutes: 545 });
    expect(readApptDate(46309)).toEqual({ date: "2026-10-14", minutes: null });
    expect(readApptDate("31/02/2026")).toBe("invalid");
    expect(readApptDate("14 Octember 2026")).toBe("invalid");
    expect(readApptDate("")).toBeNull();
  });
  it("times", () => {
    expect(readApptTime(clock(13, 5))).toBe(785);
    expect(readApptTime(0.5)).toBe(720);
    expect(readApptTime("9:30 pm")).toBe(1290);
    expect(readApptTime("25:00")).toBe("invalid");
    expect(readApptTime(5)).toBe("invalid");
  });
  it("durations and statuses", () => {
    expect(readDuration("45")).toBe(45);
    expect(readDuration(0)).toBe("invalid");
    expect(readStatus("  Honored ")).toBe("honoured");
    expect(readStatus("Awaiting Confirmation")).toBe("awaiting");
    expect(readStatus("Done")).toBe("invalid");
  });
});

describe("preview and mapping", () => {
  it("previews the mapped columns, masks the PIN and lists ignored columns by name only", async () => {
    const table = [
      [...HEADERS],
      [
        "1001",
        "14-Oct-2026",
        "09:00",
        "09:30",
        "Honoured",
        "Dr A",
        "R1",
        "C1",
        "9000001",
        SENTINELS.name,
        SENTINELS.dob,
        SENTINELS.emiratesId,
        SENTINELS.phone,
        SENTINELS.memberId,
      ],
    ];
    const p = previewAppointmentTable(table);
    expect(p.missing).toEqual([]);
    expect(p.unknown).toEqual([
      "Patient Name",
      "Date of Birth",
      "Emirates ID",
      "Mobile",
      "Member ID",
    ]);
    const text = JSON.stringify(p);
    for (const s of Object.values(SENTINELS)) expect(text).not.toContain(s);
    expect(text).not.toContain("9000001");
    expect(text).toContain("•••001");
  });

  it("no alias is a header used by two fields, and none names a patient field", () => {
    const seen = new Map<string, string>();
    for (const [field, spec] of Object.entries(APPOINTMENT_FIELDS))
      for (const alias of spec.aliases) {
        const t = headerToken(alias);
        expect(seen.get(t), `${alias} is used by ${seen.get(t)} and ${field}`).toBeUndefined();
        seen.set(t, field);
        expect(alias).not.toMatch(/patient name|birth|dob|emirates|eid|mobile|phone|member/i);
      }
  });
});
