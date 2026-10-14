/**
 * Phase C (organisation): the pure helpers behind Doctors, Staff, the Rota and My day. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { landingPathFor } from "@/lib/front-desk/landing";
import { getEvent } from "@/lib/notify/events";
import { notificationHref } from "@/lib/notify/links";
import { buildPushPayload, genericEmail } from "@/lib/notify/push-payload";
import {
  doctorCalendarHref,
  doctorProfileSchema,
  hoursSummary,
  patientShortName,
} from "@/lib/organisation/doctors";
import {
  DEFAULT_STAFF_EXPIRY_LEAD_DAYS,
  dueForReminder,
  expiryBadge,
  reminderHorizon,
  worstBadge,
} from "@/lib/organisation/expiry";
import { dayState, nextUp, summariseDay } from "@/lib/organisation/my-day";
import {
  findOverlap,
  rangesOverlap,
  shiftLabel,
  shiftRange,
  shiftTimes,
  weekDays,
  weekStart,
  weekWindow,
} from "@/lib/organisation/rota";
import { readOrganisationSettings, writeOrganisationSettings } from "@/lib/organisation/settings";
import { managerLoop, normaliseWorkPhone, staffInputSchema } from "@/lib/organisation/staff";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

describe("expiry badge", () => {
  const today = "2026-10-14";

  it("defaults to 60 days", () => {
    expect(DEFAULT_STAFF_EXPIRY_LEAD_DAYS).toBe(60);
  });

  it("is empty without a date and for a date that is not real", () => {
    expect(expiryBadge(null, today).state).toBe("none");
    expect(expiryBadge("2026-02-30", today).state).toBe("none");
    expect(expiryBadge("14/10/2026", today).state).toBe("none");
  });

  it("warns within the lead days, today and the last day included", () => {
    expect(expiryBadge("2026-10-14", today, 60)).toMatchObject({
      state: "soon",
      label: "Expires today",
      tone: "warning",
    });
    expect(expiryBadge("2026-10-15", today, 60).label).toBe("Expires tomorrow");
    expect(expiryBadge("2026-12-13", today, 60)).toMatchObject({ state: "soon", days: 60 });
    expect(expiryBadge("2026-12-14", today, 60)).toMatchObject({ state: "valid", tone: "success" });
  });

  it("turns destructive once expired", () => {
    expect(expiryBadge("2026-10-13", today)).toMatchObject({
      state: "expired",
      label: "Expired yesterday",
      tone: "destructive",
    });
    expect(expiryBadge("2026-10-01", today).label).toBe("Expired 13 days ago");
  });

  it("follows a shorter lead time", () => {
    expect(expiryBadge("2026-11-01", today, 7).state).toBe("valid");
    expect(expiryBadge("2026-10-20", today, 7).state).toBe("soon");
  });

  it("picks the worse of a visa and a licence", () => {
    const visa = expiryBadge("2027-06-01", today);
    const licence = expiryBadge("2026-10-01", today);
    expect(worstBadge([visa, licence]).state).toBe("expired");
    expect(worstBadge([]).state).toBe("none");
  });

  it("lists what is due for a reminder, never twice", () => {
    const rows = [
      { id: "a", expires_on: "2026-11-01", notified_at: null },
      { id: "b", expires_on: "2026-11-01", notified_at: "2026-10-01T00:00:00Z" },
      { id: "c", expires_on: "2027-05-01", notified_at: null },
      { id: "d", expires_on: "2026-09-01", notified_at: null },
      { id: "e", expires_on: null, notified_at: null },
    ];
    expect(dueForReminder(rows, today, 60).map((r) => r.id)).toEqual(["a", "d"]);
    expect(reminderHorizon(today, 60)).toBe("2026-12-13");
    expect(reminderHorizon("bad", 60)).toBeNull();
  });
});

describe("rota", () => {
  const tz = "Asia/Dubai";

  it("turns a local date and times into UTC instants", () => {
    expect(shiftRange("2026-10-14", "09:00", "17:00", tz)).toEqual({
      startsAt: "2026-10-14T05:00:00.000Z",
      endsAt: "2026-10-14T13:00:00.000Z",
    });
  });

  it("runs past midnight when the end is not after the start", () => {
    const r = shiftRange("2026-10-14", "22:00", "06:00", tz)!;
    expect(r.endsAt).toBe("2026-10-15T02:00:00.000Z");
    expect(shiftLabel(r, tz)).toBe("22:00–06:00 (+1)");
    expect(shiftTimes(r, tz)).toEqual({ date: "2026-10-14", start: "22:00", end: "06:00" });
  });

  it("refuses bad input", () => {
    expect(shiftRange("2026-02-30", "09:00", "17:00", tz)).toBeNull();
    expect(shiftRange("2026-10-14", "9am", "17:00", tz)).toBeNull();
    expect(shiftRange("2026-10-14", "24:00", "17:00", tz)).toBeNull();
  });

  it("treats touching shifts as fine and overlapping ones as a clash, per person", () => {
    const morning = {
      id: "m",
      staffMemberId: UUID,
      ...shiftRange("2026-10-14", "09:00", "13:00", tz)!,
    };
    const afternoon = {
      id: "a",
      staffMemberId: UUID,
      ...shiftRange("2026-10-14", "13:00", "17:00", tz)!,
    };
    const lunch = {
      id: "",
      staffMemberId: UUID,
      ...shiftRange("2026-10-14", "12:00", "14:00", tz)!,
    };
    expect(rangesOverlap(morning, afternoon)).toBe(false);
    expect(findOverlap([morning], afternoon)).toBeNull();
    expect(findOverlap([morning, afternoon], lunch)?.id).toBe("m");
    // another person at the same time is fine
    expect(findOverlap([morning], { ...lunch, staffMemberId: UUID2 })).toBeNull();
    // editing a shift never clashes with itself
    expect(findOverlap([morning], { ...morning })).toBeNull();
  });

  it("builds Monday-first weeks", () => {
    expect(weekStart("2026-10-14")).toBe("2026-10-12"); // a Wednesday
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday
    expect(weekStart("nope")).toBeNull();
    expect(weekDays("2026-10-12")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(weekWindow("2026-10-12", tz)).toEqual({
      from: "2026-10-11T20:00:00.000Z",
      to: "2026-10-18T20:00:00.000Z",
    });
  });
});

describe("staff input", () => {
  it("trims, nulls blanks and keeps no pay field", () => {
    const v = staffInputSchema.parse({
      full_name: "  Layla Demo-07 ",
      job_title: "",
      work_email: " desk@example.test ",
      visa_expires_on: "2027-01-31",
    });
    expect(v.full_name).toBe("Layla Demo-07");
    expect(v.job_title).toBeNull();
    expect(v.work_email).toBe("desk@example.test");
    expect(v.employment_type).toBe("full_time");
    expect(Object.keys(v).some((k) => /salary|pay|wage|compensation/i.test(k))).toBe(false);
  });

  it("refuses an empty name, a bad e-mail, a bad date and an end before the start", () => {
    expect(staffInputSchema.safeParse({ full_name: "  " }).success).toBe(false);
    expect(staffInputSchema.safeParse({ full_name: "A", work_email: "nope" }).success).toBe(false);
    expect(
      staffInputSchema.safeParse({ full_name: "A", visa_expires_on: "2026-13-01" }).success,
    ).toBe(false);
    expect(
      staffInputSchema.safeParse({
        full_name: "A",
        start_date: "2026-10-14",
        end_date: "2026-10-01",
      }).success,
    ).toBe(false);
  });

  it("normalises the work phone to E.164", () => {
    expect(normaliseWorkPhone("+44 7700 900123")).toBe("+447700900123");
    expect(normaliseWorkPhone("")).toBeNull();
    expect(() => normaliseWorkPhone("12")).toThrow(/not a valid number/);
  });

  it("spots a manager loop", () => {
    const managerOf = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(managerLoop("a", "c", managerOf)).toBe(true); // c -> b -> a
    expect(managerLoop("c", "a", managerOf)).toBe(false);
    expect(managerLoop("a", null, managerOf)).toBe(false);
  });
});

describe("doctors", () => {
  it("summarises working hours per branch, Monday first", () => {
    const rows = hoursSummary(
      [
        { location_id: "n", weekday: 3, start_min: 540, end_min: 1020 },
        { location_id: "n", weekday: 1, start_min: 840, end_min: 1080 },
        { location_id: "n", weekday: 1, start_min: 540, end_min: 780 },
        { location_id: "s", weekday: 7, start_min: 600, end_min: 660 },
      ],
      [
        { id: "n", name: "North" },
        { id: "s", name: "South" },
        { id: "e", name: "East" },
      ],
    );
    expect(rows).toEqual([
      {
        locationId: "n",
        locationName: "North",
        text: "Mon 09:00–13:00, 14:00–18:00 · Wed 09:00–17:00",
      },
      { locationId: "s", locationName: "South", text: "Sun 10:00–11:00" },
    ]);
  });

  it("validates the profile fields and defaults the authority to DHA", () => {
    const v = doctorProfileSchema.parse({ licence_authority: "", phone_ext: "204" });
    expect(v.licence_authority).toBe("DHA");
    expect(v.phone_ext).toBe("204");
    expect(doctorProfileSchema.safeParse({ phone_ext: "12a" }).success).toBe(false);
    expect(doctorProfileSchema.safeParse({ licence_expires_on: "2026-02-31" }).success).toBe(false);
    expect(doctorProfileSchema.safeParse({ bio: "x".repeat(501) }).success).toBe(false);
  });

  it("links to the calendar view the appointments page reads", () => {
    expect(doctorCalendarHref(UUID)).toBe(`/appointments?view=calendar&specialist=${UUID}`);
  });

  it("names a patient in the drawer by first name or initials, never in full", () => {
    expect(patientShortName("Layla Demo-07 Test", true)).toBe("Layla");
    expect(patientShortName("Layla Demo-07 Test", false)).toBe("L. T.");
    expect(patientShortName("  layla  ", false)).toBe("L.");
    expect(patientShortName("", true)).toBe("Patient");
    expect(patientShortName(null, false)).toBe("Patient");
  });
});

describe("my day", () => {
  const appt = (id: string, time: string, status: string, checkin: string | null = null) => ({
    id,
    starts_at: `2026-10-14T${time}:00.000Z`,
    status,
    checkin_status: checkin,
  });

  it("counts where each patient is, leaving cancelled visits out", () => {
    const s = summariseDay([
      appt("1", "05:00", "confirmed", "checked_out"),
      appt("2", "05:30", "confirmed", "with_doctor"),
      appt("3", "06:00", "awaiting", "arrived"),
      appt("4", "06:30", "awaiting"),
      appt("5", "07:00", "cancelled"),
      appt("6", "07:30", "no_show"),
      appt("7", "08:00", "completed"),
    ]);
    expect(s).toEqual({ total: 6, expected: 1, waiting: 1, withDoctor: 1, seen: 2, noShow: 1 });
    expect(dayState({ status: "completed", checkin_status: null })).toBe("done");
    expect(dayState({ status: "confirmed", checkin_status: "bogus" })).toBe("expected");
  });

  it("puts the first waiting patient next, else the next one booked", () => {
    const now = new Date("2026-10-14T06:10:00Z");
    const list = [
      appt("a", "05:00", "confirmed"),
      appt("b", "06:30", "confirmed"),
      appt("c", "07:00", "confirmed", "arrived"),
    ];
    expect(nextUp(list, now)?.id).toBe("c");
    expect(nextUp(list.slice(0, 2), now)?.id).toBe("b");
    expect(nextUp([], now)).toBeNull();
  });
});

describe("landing", () => {
  const base = { status: "active" as const, permissions: [] as string[] };
  it("opens My day for the Doctor role, only with appointments.view", () => {
    expect(
      landingPathFor({ ...base, roleName: "Doctor", permissions: ["appointments.view"] }),
    ).toBe("/my-day");
    expect(
      landingPathFor({ ...base, roleName: " doctor ", permissions: ["appointments.view"] }),
    ).toBe("/my-day");
    expect(landingPathFor({ ...base, roleName: "Doctor", permissions: [] })).toBe("/dashboard");
    expect(landingPathFor({ ...base, roleName: "HR", permissions: ["hr.view"] })).toBe(
      "/dashboard",
    );
    expect(
      landingPathFor({ ...base, roleName: "Receptionist", permissions: ["frontdesk.use"] }),
    ).toBe("/front-desk");
  });
});

describe("settings", () => {
  it("reads 60 days by default, keeps other settings when writing, and refuses nonsense", () => {
    expect(readOrganisationSettings(null).expiry_lead_days).toBe(60);
    expect(
      readOrganisationSettings({ organisation: { expiry_lead_days: 500 } }).expiry_lead_days,
    ).toBe(60);
    const next = writeOrganisationSettings(
      { documents: { enabled: true } },
      { expiry_lead_days: 30 },
    );
    expect(next).toEqual({ documents: { enabled: true }, organisation: { expiry_lead_days: 30 } });
    expect(readOrganisationSettings(next).expiry_lead_days).toBe(30);
  });
});

describe("staff.document_expiring notification", () => {
  it("is offered to people who manage staff, with generic push and e-mail text", () => {
    expect(getEvent("staff.document_expiring")?.permission).toBe("hr.manage");
    const p = buildPushPayload("staff.document_expiring", {})!;
    expect(p.url).toBe("/staff");
    expect(p.body).not.toMatch(/Demo|\+44|@/);
    expect(genericEmail("staff.document_expiring")?.subject).toBe("Staff document expiring");
  });

  it("opens the staff record or the doctor by id, never by a name", () => {
    expect(notificationHref("staff.document_expiring", { staff_member_id: UUID })).toBe(
      `/staff?staff=${UUID}`,
    );
    expect(notificationHref("staff.document_expiring", { specialist_id: UUID })).toBe(
      `/doctors?doctor=${UUID}`,
    );
    expect(notificationHref("staff.document_expiring", { staff_member_id: "Layla Demo-07" })).toBe(
      "/staff",
    );
    expect(notificationHref("staff.document_expiring", { count: 3 })).toBe("/staff");
  });
});
