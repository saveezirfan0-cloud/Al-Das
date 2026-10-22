/**
 * Reminder planning and template values (pure).
 *
 * Booking rules define up to three reminders relative to the appointment start ("offsets"), or one
 * reminder on the day before the visit at set times ("day_before", Make's 12:00 run with the 18:00
 * catch-up, docs/49 D8). Each reminder is a row in appointment_reminders (unique per appointment + idx)
 * plus one scheduled_jobs entry, so a re-sync or an edit can never double-send.
 */
import { formatInTimeZone } from "date-fns-tz";

import { localDate, localMinutesToInstant, shiftLocalDate } from "@/lib/appointments/slots";
import { isInactive, type AppointmentStatus } from "@/lib/appointments/status";
import { titleCase } from "@/lib/flow-engine/interpolate";
import { householdNameValues } from "@/lib/household/addressing";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ReminderRule = { enabled: boolean; hours_before: number };

/** "offsets": the rules above. "day_before": one reminder the day before the visit, at the first of `times` still ahead. */
export type ReminderSchedule = { mode: "offsets" | "day_before"; times: readonly string[] };

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
  schedule?: ReminderSchedule;
  timezone?: string;
}): DesiredReminder[] {
  if (isInactive(opts.status)) return [];
  if (opts.schedule?.mode === "day_before") {
    // Make: 12:00 for every appointment of tomorrow, 18:00 for those booked since; nothing later, nothing same-day.
    const next = dayBeforeRuns(opts.startsAt, opts.schedule, opts.timezone ?? "Asia/Dubai").find(
      (run) => run.getTime() > opts.now.getTime(),
    );
    return next ? [{ idx: 1, dueAt: next }] : [];
  }
  const out: DesiredReminder[] = [];
  opts.rules.slice(0, 3).forEach((rule, i) => {
    if (!rule.enabled) return;
    const dueAt = new Date(opts.startsAt.getTime() - rule.hours_before * HOUR_MS);
    if (dueAt.getTime() <= opts.now.getTime()) return;
    out.push({ idx: i + 1, dueAt });
  });
  return out;
}

function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The run times on the local day before the visit, earliest first. */
export function dayBeforeRuns(
  startsAt: Date,
  schedule: ReminderSchedule,
  timezone: string,
): Date[] {
  const dayBefore = shiftLocalDate(localDate(startsAt, timezone), -1);
  return [...new Set(schedule.times.map(minutesOf).filter((m): m is number => m !== null))]
    .sort((a, b) => a - b)
    .map((m) => localMinutesToInstant(dayBefore, m, timezone));
}

/**
 * Make's implicit retry: a day-before reminder that failed is tried again at the next run of the same
 * day (the 18:00 run skips only appointments with a logged send). Null when there is no later run, the
 * schedule is "offsets", or that run has passed; the failure is then reported as before.
 */
export function reminderRetryAt(opts: {
  dueAt: Date;
  startsAt: Date;
  now: Date;
  schedule: ReminderSchedule;
  timezone: string;
}): Date | null {
  if (opts.schedule.mode !== "day_before") return null;
  const next = dayBeforeRuns(opts.startsAt, opts.schedule, opts.timezone).find(
    (run) => run.getTime() > opts.dueAt.getTime(),
  );
  if (!next || next.getTime() <= opts.now.getTime() || next >= opts.startsAt) return null;
  return next;
}

/**
 * Appointments brought over from Sanoflow (source 'import') get no reminders until an administrator
 * turns `import_reminders_enabled` on under Settings → Appointments, after Sanoflow's own reminders
 * are off and the setup has been tested (docs/22). Every other source is unaffected.
 */
export function remindersAllowed(
  source: string | null | undefined,
  settings: { import_reminders_enabled: boolean },
): boolean {
  return source !== "import" || settings.import_reminders_enabled;
}

/**
 * Diff the desired reminders against what is stored. A reminder is (re)scheduled when it is new or
 * its due time moved (appointment rescheduled); rows no longer wanted are cancelled unless they have
 * already gone out. `sameDue` says when a stored due time still counts as the same reminder: exact
 * equality for offsets; the same local day for day-before runs, so a reminder sent or failed at 12:00
 * is not sent again at 18:00 by a re-sync, while a move to another day plans it afresh.
 */
export function planReminders(
  desired: readonly DesiredReminder[],
  existing: readonly ExistingReminder[],
  sameDue: (stored: Date, wanted: Date) => boolean = (a, b) => a.getTime() === b.getTime(),
): { upsert: DesiredReminder[]; cancel: number[] } {
  const byIdx = new Map(existing.map((e) => [e.idx, e]));
  const upsert: DesiredReminder[] = [];
  for (const d of desired) {
    const e = byIdx.get(d.idx);
    if (!e || !sameDue(new Date(e.due_at), d.dueAt) || e.status === "cancelled") {
      upsert.push(d);
    }
  }
  const wanted = new Set(desired.map((d) => d.idx));
  const cancel = existing
    .filter((e) => !wanted.has(e.idx) && e.status === "scheduled")
    .map((e) => e.idx);
  return { upsert, cancel };
}

/** Same local calendar day: the day-before comparison for planReminders. */
export function sameLocalDay(timezone: string): (a: Date, b: Date) => boolean {
  return (a, b) => localDate(a, timezone) === localDate(b, timezone);
}

/** Key of the retry job (a different key, so it never collides with the job being processed). */
export function reminderRetryDedupeKey(appointmentId: string, idx: number): string {
  return `${reminderDedupeKey(appointmentId, idx)}:retry`;
}

export function reminderDedupeKey(appointmentId: string, idx: number): string {
  return `reminder:${appointmentId}:${idx}`;
}

/** Patient-friendly time, e.g. "Mon 12 Oct, 9:00 AM" (Make sent the raw Unite string). */
export function formatAppointmentTime(startsAt: Date, timezone: string): string {
  return formatInTimeZone(startsAt, timezone, "EEE d MMM, h:mm a");
}

export type AppointmentTemplateContext = {
  /** The patient the appointment belongs to. */
  contact: { first_name: string | null; last_name: string | null };
  /**
   * Set when the message is written to the patient's guardian (a household dependant). The guardian's name
   * goes in `contact.*` and the patient is named alongside it; see lib/household/addressing.ts.
   */
  guardian?: { first_name: string | null; last_name: string | null } | null;
  /** The template maps a `patient.*` variable itself, so `contact.*` stays the plain guardian name. */
  explicitPatientVariable?: boolean;
  startsAt: Date;
  timezone: string;
  specialist?: string | null;
  location?: string | null;
  service?: string | null;
  number?: number | null;
  /** Front desk "running late" template: how many minutes behind the clinic is. */
  delayMinutes?: number | null;
  /**
   * What `appointment.video_link` should say (Phase 19b): the room address for a video visit, a plain sentence when the visit is
   * video but has no link yet, "at the clinic" otherwise. Built by lib/integrations/telehealth (videoLinkValue); never empty.
   */
  videoLinkText?: string | null;
};

/** Values a variable_map entry may point at. */
export function appointmentValueMap(ctx: AppointmentTemplateContext): Record<string, string> {
  // Make: ifempty(first(split(startcase(full name); space)); "Patient"), so the first word in title case.
  const first = titleCase((ctx.contact.first_name ?? "").trim().split(/\s+/)[0] ?? "") || "Patient";
  const last = (ctx.contact.last_name ?? "").trim();
  const household = householdNameValues({
    patient: ctx.contact,
    guardian: ctx.guardian ?? null,
    explicitPatientVariable: ctx.explicitPatientVariable ?? false,
  });
  return {
    "contact.first_name": first,
    "contact.last_name": last,
    "contact.name": [first === "Patient" ? "" : first, last].filter(Boolean).join(" ") || "Patient",
    ...household,
    "appointment.datetime": formatAppointmentTime(ctx.startsAt, ctx.timezone),
    "appointment.date": formatInTimeZone(ctx.startsAt, ctx.timezone, "EEEE d MMMM"),
    "appointment.time": formatInTimeZone(ctx.startsAt, ctx.timezone, "h:mm a"),
    "appointment.specialist": ctx.specialist?.trim() || "your doctor",
    "appointment.location": ctx.location?.trim() || "the clinic",
    "appointment.service": ctx.service?.trim() || "your appointment",
    "appointment.number": ctx.number ? String(ctx.number) : "",
    "delay.minutes": ctx.delayMinutes ? String(ctx.delayMinutes) : "",
    "appointment.video_link": ctx.videoLinkText?.trim() || "at the clinic",
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
  const values = appointmentValueMap({
    ...ctx,
    explicitPatientVariable:
      ctx.explicitPatientVariable ??
      Object.values(variableMap ?? {}).some(
        (v) => typeof v === "string" && v.startsWith("patient."),
      ),
  });
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
