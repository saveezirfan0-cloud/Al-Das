/**
 * Reminder planning and template values (pure).
 *
 * Booking rules define up to three reminders relative to the appointment start. Each reminder is a
 * row in appointment_reminders (unique per appointment + idx) plus one scheduled_jobs entry, so a
 * re-sync or an edit can never double-send.
 */
import { formatInTimeZone } from "date-fns-tz";

import { isInactive, type AppointmentStatus } from "@/lib/appointments/status";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ReminderRule = { enabled: boolean; hours_before: number };

export type DesiredReminder = { idx: number; dueAt: Date };

export type ExistingReminder = { idx: number; due_at: string; status: string };

const HOUR_MS = 3_600_000;

/**
 * Reminders that should exist for an appointment. A reminder whose due time has already passed is
 * dropped (never send "24h before" a few hours before), and inactive appointments have none.
 */
export function computeReminders(opts: {
  startsAt: Date;
  now: Date;
  status: AppointmentStatus;
  rules: readonly ReminderRule[];
}): DesiredReminder[] {
  if (isInactive(opts.status)) return [];
  const out: DesiredReminder[] = [];
  opts.rules.slice(0, 3).forEach((rule, i) => {
    if (!rule.enabled) return;
    const dueAt = new Date(opts.startsAt.getTime() - rule.hours_before * HOUR_MS);
    if (dueAt.getTime() <= opts.now.getTime()) return;
    out.push({ idx: i + 1, dueAt });
  });
  return out;
}

/**
 * Diff the desired reminders against what is stored. A reminder is (re)scheduled when it is new or
 * its due time moved (appointment rescheduled); rows no longer wanted are cancelled unless they have
 * already gone out.
 */
export function planReminders(
  desired: readonly DesiredReminder[],
  existing: readonly ExistingReminder[],
): { upsert: DesiredReminder[]; cancel: number[] } {
  const byIdx = new Map(existing.map((e) => [e.idx, e]));
  const upsert: DesiredReminder[] = [];
  for (const d of desired) {
    const e = byIdx.get(d.idx);
    if (!e || new Date(e.due_at).getTime() !== d.dueAt.getTime() || e.status === "cancelled") {
      upsert.push(d);
    }
  }
  const wanted = new Set(desired.map((d) => d.idx));
  const cancel = existing
    .filter((e) => !wanted.has(e.idx) && e.status === "scheduled")
    .map((e) => e.idx);
  return { upsert, cancel };
}

export function reminderDedupeKey(appointmentId: string, idx: number): string {
  return `reminder:${appointmentId}:${idx}`;
}

/** Patient-friendly time, e.g. "Mon 12 Oct, 9:00 AM" (Make sent the raw Unite string). */
export function formatAppointmentTime(startsAt: Date, timezone: string): string {
  return formatInTimeZone(startsAt, timezone, "EEE d MMM, h:mm a");
}

export type AppointmentTemplateContext = {
  contact: { first_name: string | null; last_name: string | null };
  startsAt: Date;
  timezone: string;
  specialist?: string | null;
  location?: string | null;
  service?: string | null;
  number?: number | null;
};

/** Values a variable_map entry may point at. */
export function appointmentValueMap(ctx: AppointmentTemplateContext): Record<string, string> {
  const first = (ctx.contact.first_name ?? "").trim().split(/\s+/)[0] || "Patient";
  const last = (ctx.contact.last_name ?? "").trim();
  return {
    "contact.first_name": first,
    "contact.last_name": last,
    "contact.name": [first === "Patient" ? "" : first, last].filter(Boolean).join(" ") || "Patient",
    "appointment.datetime": formatAppointmentTime(ctx.startsAt, ctx.timezone),
    "appointment.date": formatInTimeZone(ctx.startsAt, ctx.timezone, "EEEE d MMMM"),
    "appointment.time": formatInTimeZone(ctx.startsAt, ctx.timezone, "h:mm a"),
    "appointment.specialist": ctx.specialist?.trim() || "your doctor",
    "appointment.location": ctx.location?.trim() || "the clinic",
    "appointment.service": ctx.service?.trim() || "your appointment",
    "appointment.number": ctx.number ? String(ctx.number) : "",
  };
}

/** Default body-variable order when a template has no variable_map: name, time, doctor, location. */
const DEFAULT_BODY_MAP = [
  "contact.first_name",
  "appointment.datetime",
  "appointment.specialist",
  "appointment.location",
];

/**
 * Template send values for an appointment notification. Body variables are resolved from the
 * template's variable_map ("body.1" → "appointment.datetime"), falling back to the order the old
 * Make reminder used: first name, time, doctor.
 */
export function buildAppointmentTemplateValues(
  components: MetaTemplateComponent[],
  variableMap: Record<string, string> | null | undefined,
  ctx: AppointmentTemplateContext,
): Record<string, string> {
  const values = appointmentValueMap(ctx);
  const out: Record<string, string> = {};
  for (const v of templateVariables(components)) {
    if (v.component === "button" || v.kind !== "text") continue;
    const mapped = variableMap?.[v.key];
    const fallback = v.index ? DEFAULT_BODY_MAP[v.index - 1] : undefined;
    const source = mapped ?? (v.component === "body" ? fallback : undefined);
    if (source && source in values) out[v.key] = values[source];
  }
  return out;
}
