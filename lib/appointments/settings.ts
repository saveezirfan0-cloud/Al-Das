import { z } from "zod";

/**
 * Booking rules and notification template mapping, stored in orgs.settings->'appointments'.
 * Same pattern as lib/inbox/settings.ts: one Zod schema, tolerant reader, immutable writer.
 */
const reminderRule = z.object({
  enabled: z.boolean(),
  /** Hours before the appointment start. */
  hours_before: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
});

const templateId = z.string().uuid().nullable().default(null);

export const appointmentSettingsSchema = z.object({
  /** Exactly three reminders, each relative to the appointment start. Defaults mirror today's Make run: only 24h. */
  reminders: z
    .array(reminderRule)
    .length(3)
    .default([
      { enabled: false, hours_before: 48 },
      { enabled: true, hours_before: 24 },
      { enabled: false, hours_before: 3 },
    ]),
  /** Earliest bookable moment from now, in minutes (the UI edits days / hours / minutes). */
  lead_time_minutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 365)
    .default(60),
  /** Patients may reschedule / cancel until this many minutes before the start. */
  reschedule_cutoff_minutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 60)
    .default(120),
  cancel_cutoff_minutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 60)
    .default(120),
  /** New portal / bot bookings start as Confirmed instead of Awaiting. */
  auto_confirm: z.boolean().default(false),
  /** Slot list step in minutes. */
  slot_granularity_min: z.number().int().min(5).max(120).default(15),
  /** ISO weekdays the clinic works (1 = Monday … 7 = Sunday). OQ-07: configurable until signed off. */
  working_weekdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5, 6]),
  /** Non-working dates, YYYY-MM-DD in the location timezone. */
  holidays: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .max(400)
    .default([]),
  /** Number reminders and status notifications are sent from (null = first active channel). */
  channel_id: z.string().uuid().nullable().default(null),
  templates: z
    .object({
      reminder: templateId,
      confirmed: templateId,
      cancelled: templateId,
      rescheduled: templateId,
    })
    .default({ reminder: null, confirmed: null, cancelled: null, rescheduled: null }),
  /** Parallel-run safety: reminders go only to contacts whose phone is in reminder_test_numbers. */
  reminder_test_mode: z.boolean().default(false),
  reminder_test_numbers: z
    .array(z.string().regex(/^\+[1-9][0-9]{6,14}$/))
    .max(20)
    .default([]),
});

export type AppointmentSettings = z.infer<typeof appointmentSettingsSchema>;

export const DEFAULT_APPOINTMENT_SETTINGS: AppointmentSettings = appointmentSettingsSchema.parse(
  {},
);

/** Reads org.settings (jsonb) → AppointmentSettings, tolerating missing or invalid values. */
export function readAppointmentSettings(orgSettings: unknown): AppointmentSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).appointments
      : undefined;
  const parsed = appointmentSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_APPOINTMENT_SETTINGS;
}

/** Returns a new org.settings object with the appointments section replaced. */
export function writeAppointmentSettings(
  orgSettings: unknown,
  next: AppointmentSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.appointments = next;
  return base;
}
