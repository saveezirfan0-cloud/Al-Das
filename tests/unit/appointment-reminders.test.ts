import { describe, expect, it } from "vitest";

import { classifyButtonReply, decideReply } from "@/lib/appointments/button-reply";
import {
  appointmentValueMap,
  buildAppointmentTemplateValues,
  computeReminders,
  formatAppointmentTime,
  planReminders,
  reminderDedupeKey,
} from "@/lib/appointments/reminders";
import {
  appointmentSettingsSchema,
  readAppointmentSettings,
  writeAppointmentSettings,
} from "@/lib/appointments/settings";
import { canTransition, isInactive } from "@/lib/appointments/status";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const rules = [
  { enabled: true, hours_before: 48 },
  { enabled: true, hours_before: 24 },
  { enabled: false, hours_before: 3 },
];
const starts = new Date("2026-10-14T10:00:00Z");

describe("computeReminders", () => {
  it("creates one reminder per enabled rule relative to the start", () => {
    const r = computeReminders({
      startsAt: starts,
      now: new Date("2026-10-01T00:00:00Z"),
      status: "awaiting",
      rules,
    });
    expect(r.map((x) => [x.idx, x.dueAt.toISOString()])).toEqual([
      [1, "2026-10-12T10:00:00.000Z"],
      [2, "2026-10-13T10:00:00.000Z"],
    ]);
  });

  it("drops reminders whose time has already passed", () => {
    const r = computeReminders({
      startsAt: starts,
      now: new Date("2026-10-12T12:00:00Z"), // 48h mark passed, 24h not
      status: "confirmed",
      rules,
    });
    expect(r.map((x) => x.idx)).toEqual([2]);
  });

  it("returns nothing for cancelled, no-show and completed appointments", () => {
    for (const status of ["cancelled", "no_show", "completed"] as const) {
      expect(
        computeReminders({
          startsAt: starts,
          now: new Date("2026-10-01T00:00:00Z"),
          status,
          rules,
        }),
      ).toEqual([]);
    }
  });
});

describe("planReminders", () => {
  const desired = [
    { idx: 1, dueAt: new Date("2026-10-12T10:00:00Z") },
    { idx: 2, dueAt: new Date("2026-10-13T10:00:00Z") },
  ];

  it("schedules everything when nothing exists", () => {
    expect(planReminders(desired, [])).toEqual({ upsert: desired, cancel: [] });
  });

  it("is idempotent when rows already match", () => {
    const existing = desired.map((d) => ({
      idx: d.idx,
      due_at: d.dueAt.toISOString(),
      status: "scheduled",
    }));
    expect(planReminders(desired, existing)).toEqual({ upsert: [], cancel: [] });
  });

  it("re-schedules when the appointment moved, even if the old reminder was sent", () => {
    const existing = [
      { idx: 1, due_at: "2026-10-10T10:00:00.000Z", status: "sent" },
      { idx: 2, due_at: "2026-10-13T10:00:00.000Z", status: "scheduled" },
    ];
    expect(planReminders(desired, existing).upsert.map((d) => d.idx)).toEqual([1]);
  });

  it("cancels scheduled rows no longer wanted but keeps sent history", () => {
    const existing = [
      { idx: 1, due_at: desired[0].dueAt.toISOString(), status: "scheduled" },
      { idx: 3, due_at: "2026-10-14T07:00:00.000Z", status: "scheduled" },
      { idx: 2, due_at: desired[1].dueAt.toISOString(), status: "sent" },
    ];
    expect(planReminders([desired[0]], existing).cancel).toEqual([3]);
  });

  it("re-activates a cancelled row that is wanted again", () => {
    const existing = [{ idx: 1, due_at: desired[0].dueAt.toISOString(), status: "cancelled" }];
    expect(planReminders([desired[0]], existing).upsert).toHaveLength(1);
  });

  it("builds a stable dedupe key per appointment and slot", () => {
    expect(reminderDedupeKey("abc", 2)).toBe("reminder:abc:2");
  });
});

describe("template values", () => {
  const components: MetaTemplateComponent[] = [
    { type: "BODY", text: "Hi {{1}}, your visit is {{2}} with {{3}}." },
  ] as MetaTemplateComponent[];
  const ctx = {
    contact: { first_name: "Sara Test", last_name: "Example" },
    startsAt: new Date("2026-10-12T05:00:00Z"),
    timezone: "Asia/Dubai",
    specialist: "Dr Example",
    location: "Test Clinic",
  };

  it("formats the time for the patient in the location timezone", () => {
    expect(formatAppointmentTime(ctx.startsAt, "Asia/Dubai")).toBe("Mon 12 Oct, 9:00 AM");
  });

  it("falls back to name, time, doctor like the old Make reminder", () => {
    expect(buildAppointmentTemplateValues(components, null, ctx)).toEqual({
      "body.1": "Sara",
      "body.2": "Mon 12 Oct, 9:00 AM",
      "body.3": "Dr Example",
    });
  });

  it("honours variable_map and uses 'Patient' when the name is blank", () => {
    const v = buildAppointmentTemplateValues(
      components,
      {
        "body.1": "appointment.location",
        "body.2": "appointment.time",
        "body.3": "contact.first_name",
      },
      { ...ctx, contact: { first_name: "  ", last_name: null } },
    );
    expect(v).toEqual({ "body.1": "Test Clinic", "body.2": "9:00 AM", "body.3": "Patient" });
  });

  it("uses safe wording when specialist or location are unknown", () => {
    const map = appointmentValueMap({ ...ctx, specialist: null, location: undefined });
    expect(map["appointment.specialist"]).toBe("your doctor");
    expect(map["appointment.location"]).toBe("the clinic");
  });
});

describe("button replies", () => {
  const rule = { cancel_cutoff_minutes: 120, reschedule_cutoff_minutes: 120 };
  const appt = { status: "awaiting" as const, startsAt: new Date("2026-10-14T10:00:00Z") };
  const now = new Date("2026-10-13T10:00:00Z");

  it("classifies payloads and titles", () => {
    expect(classifyButtonReply({ id: "CONFIRM" })).toBe("confirm");
    expect(classifyButtonReply({ title: "Reschedule" })).toBe("reschedule");
    expect(classifyButtonReply({ id: null, title: "Cancel appointment" })).toBe("cancel");
    expect(classifyButtonReply({ id: "stop_marketing", title: "Stop" })).toBe("unknown");
  });

  it("confirms an awaiting appointment and ignores a repeat", () => {
    expect(decideReply("confirm", appt, rule, now)).toEqual({
      kind: "set_status",
      status: "confirmed",
    });
    expect(decideReply("confirm", { ...appt, status: "confirmed" }, rule, now)).toEqual({
      kind: "ignore",
      reason: "already_applied",
    });
  });

  it("cancels before the cut-off, escalates after it", () => {
    expect(decideReply("cancel", appt, rule, now)).toEqual({
      kind: "set_status",
      status: "cancelled",
    });
    const late = new Date("2026-10-14T09:00:00Z"); // 60 min before start
    expect(decideReply("cancel", appt, rule, late)).toEqual({
      kind: "notify_reception",
      reason: "cancel_too_late",
    });
  });

  it("asks reception to re-book on a reschedule request", () => {
    expect(decideReply("reschedule", appt, rule, now)).toEqual({
      kind: "notify_reception",
      reason: "reschedule_requested",
    });
  });

  it("flags a reschedule tapped inside the cut-off as late", () => {
    const late = new Date("2026-10-14T09:00:00Z"); // 60 min before start, cut-off 120
    expect(decideReply("reschedule", appt, rule, late)).toEqual({
      kind: "notify_reception",
      reason: "reschedule_too_late",
    });
  });

  it("never reopens a closed appointment or acts on the past", () => {
    expect(decideReply("confirm", { ...appt, status: "cancelled" }, rule, now).kind).toBe("ignore");
    expect(decideReply("confirm", appt, rule, new Date("2026-10-15T00:00:00Z"))).toEqual({
      kind: "ignore",
      reason: "past",
    });
    expect(decideReply("unknown", appt, rule, now)).toEqual({
      kind: "ignore",
      reason: "unknown_button",
    });
  });
});

describe("status + settings", () => {
  it("allows sensible transitions only", () => {
    expect(canTransition("awaiting", "confirmed")).toBe(true);
    expect(canTransition("cancelled", "completed")).toBe(false);
    expect(canTransition("confirmed", "confirmed")).toBe(false);
    expect(isInactive("no_show")).toBe(true);
    expect(isInactive("confirmed")).toBe(false);
  });

  it("defaults mirror today's Make run: only the 24h reminder is on", () => {
    const s = appointmentSettingsSchema.parse({});
    expect(s.reminders).toHaveLength(3);
    expect(s.reminders.filter((r) => r.enabled).map((r) => r.hours_before)).toEqual([24]);
    expect(s.reminder_test_mode).toBe(false);
  });

  it("tolerates junk and round-trips through org.settings", () => {
    expect(readAppointmentSettings({ appointments: { reminders: "nope" } }).lead_time_minutes).toBe(
      60,
    );
    const next = { ...readAppointmentSettings(null), auto_confirm: true };
    const written = writeAppointmentSettings({ inbox: { x: 1 } }, next);
    expect(written.inbox).toEqual({ x: 1 });
    expect(readAppointmentSettings(written).auto_confirm).toBe(true);
  });
});
