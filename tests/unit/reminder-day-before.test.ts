import { describe, expect, it } from "vitest";

import {
  appointmentValueMap,
  computeReminders,
  planReminders,
  reminderDedupeKey,
  reminderRetryAt,
  reminderRetryDedupeKey,
  sameLocalDay,
  type ReminderSchedule,
} from "@/lib/appointments/reminders";
import { appointmentSettingsSchema, readAppointmentSettings } from "@/lib/appointments/settings";
import { interpolate, titleCase } from "@/lib/flow-engine/interpolate";

// Make's Appointment Reminders: 12:00 for every appointment of tomorrow, 18:00 for the rest (docs/49 D8).
const TZ = "Asia/Dubai"; // UTC+4, no DST
const MAKE: ReminderSchedule = { mode: "day_before", times: ["12:00", "18:00"] };
const visit = new Date("2026-10-15T06:30:00Z"); // 10:30 Dubai on 15 Oct
const noonBefore = new Date("2026-10-14T08:00:00Z"); // 12:00 Dubai on 14 Oct
const sixBefore = new Date("2026-10-14T14:00:00Z"); // 18:00 Dubai on 14 Oct
const plan = (now: Date, startsAt = visit) =>
  computeReminders({
    startsAt,
    now,
    status: "awaiting",
    rules: [],
    schedule: MAKE,
    timezone: TZ,
  });

describe("day-before reminders (Make's 12:00 and 18:00 runs)", () => {
  it("books ahead: one reminder at 12:00 on the day before", () => {
    expect(plan(new Date("2026-10-10T08:00:00Z"))).toEqual([{ idx: 1, dueAt: noonBefore }]);
  });

  it("booked after noon on the day before: the 18:00 catch-up", () => {
    expect(plan(new Date("2026-10-14T09:15:00Z"))).toEqual([{ idx: 1, dueAt: sixBefore }]);
  });

  it("booked after 18:00 on the day before, or for today: nothing (as Make)", () => {
    expect(plan(new Date("2026-10-14T14:30:00Z"))).toEqual([]);
    expect(plan(new Date("2026-10-15T04:00:00Z"))).toEqual([]);
  });

  it("an early-morning visit is still reminded on the local day before", () => {
    const early = new Date("2026-10-15T03:00:00Z"); // 07:00 Dubai on 15 Oct
    expect(plan(new Date("2026-10-01T00:00:00Z"), early)).toEqual([{ idx: 1, dueAt: noonBefore }]);
  });

  it("inactive appointments get nothing", () => {
    expect(
      computeReminders({
        startsAt: visit,
        now: new Date("2026-10-10T00:00:00Z"),
        status: "cancelled",
        rules: [],
        schedule: MAKE,
        timezone: TZ,
      }),
    ).toEqual([]);
  });

  it("a re-sync after 12:00 does not re-arm a reminder already sent or failed at 12:00", () => {
    const after = plan(new Date("2026-10-14T09:00:00Z")); // desired now says 18:00
    for (const status of ["sent", "failed", "excluded", "scheduled"]) {
      expect(
        planReminders(
          after,
          [{ idx: 1, due_at: noonBefore.toISOString(), status }],
          sameLocalDay(TZ),
        ).upsert,
      ).toEqual([]);
    }
  });

  it("a move to another day plans the reminder afresh", () => {
    const moved = plan(new Date("2026-10-10T08:00:00Z"), new Date("2026-10-17T06:30:00Z"));
    expect(
      planReminders(
        moved,
        [{ idx: 1, due_at: noonBefore.toISOString(), status: "sent" }],
        sameLocalDay(TZ),
      ).upsert,
    ).toEqual(moved);
  });

  it("the offsets mode keeps exact due-time comparison", () => {
    const desired = [{ idx: 2, dueAt: new Date("2026-10-14T06:30:00Z") }];
    expect(
      planReminders(desired, [{ idx: 2, due_at: "2026-10-14T06:00:00.000Z", status: "sent" }])
        .upsert,
    ).toEqual(desired);
  });
});

describe("Make's implicit retry at 18:00", () => {
  const retry = (dueAt: Date, now: Date, schedule = MAKE) =>
    reminderRetryAt({ dueAt, startsAt: visit, now, schedule, timezone: TZ });

  it("a 12:00 failure is tried again at 18:00 the same day", () => {
    expect(retry(noonBefore, new Date("2026-10-14T08:01:00Z"))).toEqual(sixBefore);
  });

  it("an 18:00 failure is final, and so is any failure once 18:00 has passed", () => {
    expect(retry(sixBefore, new Date("2026-10-14T14:01:00Z"))).toBeNull();
    expect(retry(noonBefore, new Date("2026-10-14T14:05:00Z"))).toBeNull();
  });

  it("offsets mode never retries", () => {
    expect(
      retry(noonBefore, new Date("2026-10-14T08:01:00Z"), { mode: "offsets", times: ["12:00"] }),
    ).toBeNull();
  });

  it("the retry job has its own key", () => {
    expect(reminderRetryDedupeKey("a", 1)).not.toBe(reminderDedupeKey("a", 1));
  });
});

describe("reminder schedule setting", () => {
  it("defaults to offsets (behaviour unchanged) with Make's times ready", () => {
    expect(appointmentSettingsSchema.parse({}).reminder_schedule).toEqual({
      mode: "offsets",
      times: ["12:00", "18:00"],
    });
  });

  it("refuses bad times and repeats", () => {
    const bad = (times: string[]) =>
      appointmentSettingsSchema.safeParse({ reminder_schedule: { mode: "day_before", times } })
        .success;
    expect(bad(["25:00"])).toBe(false);
    expect(bad(["12:00", "12:00"])).toBe(false);
    expect(bad([])).toBe(false);
    expect(bad(["12:00", "18:00"])).toBe(true);
  });

  it("stored settings without the field still read", () => {
    expect(
      readAppointmentSettings({ appointments: { reminder_test_mode: true } }).reminder_schedule
        .mode,
    ).toBe("offsets");
  });
});

describe("title case like Make's startcase (D17)", () => {
  it("capitalises each word and lowers the rest", () => {
    expect(titleCase("mARY ann")).toBe("Mary Ann");
    expect(titleCase("")).toBe("");
    expect(
      interpolate("{contact.first_name|title|default:Patient}", { contact: { first_name: "" } })
        .text,
    ).toBe("Patient");
    expect(
      interpolate("{contact.first_name|title}", { contact: { first_name: "aHMED" } }).text,
    ).toBe("Ahmed");
  });

  it("reminder {{1}}: the first word of the first name, title-cased, else Patient", () => {
    const base = { startsAt: visit, timezone: TZ };
    expect(
      appointmentValueMap({ ...base, contact: { first_name: "fATIMA zahra", last_name: "" } })[
        "contact.first_name"
      ],
    ).toBe("Fatima");
    expect(
      appointmentValueMap({ ...base, contact: { first_name: "  ", last_name: "" } })[
        "contact.first_name"
      ],
    ).toBe("Patient");
  });
});
