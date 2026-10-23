/**
 * W2 from the Unite connection (docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md): turns one finished day of synced Unite
 * appointments (`appointments`, source 'unite') into the same sanitised rows an appointment file gives, so matching,
 * utilisation and capacity work unchanged. Pure; the loader and the hand-over are in `appointment-api-server.ts`.
 *
 * Fails closed: a row whose Unite status code has no meaning in Settings, Unite (OQ-23) stops the whole day, and the
 * reason lists the codes only. A day is never handed over half-read.
 */
import { formatInTimeZone } from "date-fns-tz";

import type { AppointmentStatus as PulseStatus } from "@/lib/appointments/status";
import type { AppointmentStatus } from "@/lib/finance/appointment-mapping";
import type { AppointmentRow } from "@/lib/finance/parse-appointments";
import {
  NO_DOCTOR_KEY,
  NO_DOCTOR_NAME,
  normaliseDoctorKey,
} from "@/lib/finance/unite-report-mapping";

/** Pulse's appointment status as W2 reads it. A no-show was booked and not seen, like a confirmed one. */
export const W2_STATUS: Record<PulseStatus, AppointmentStatus> = {
  awaiting: "awaiting",
  confirmed: "confirmed",
  completed: "honoured",
  cancelled: "cancelled",
  no_show: "confirmed",
};

export type SyncedAppointment = {
  externalId: string;
  startsAt: string;
  endsAt: string;
  /** Unite's own status code (`appointments.external_status`). */
  externalStatus: string | null;
  /** True only when Unite sent an end time (`custom.unite_end_given`); otherwise the length is unknown. */
  endGiven: boolean;
  patientPin: string | null;
  /** The linked doctor's name, else the name Unite sent. */
  doctorName: string | null;
  /** The Unite clinic name this appointment's branch is mapped through, or null. */
  clinicName: string | null;
};

export type DayRows =
  { ok: true; rows: AppointmentRow[] } | { ok: false; reason: "unmapped_status"; codes: string[] };

/**
 * The rows for `day` (yyyy-mm-dd in `timezone`). `statusMap` is Unite code → Pulse status, null when the code's
 * meaning is not set. Appointments outside the day are ignored; rows are ordered by appointment id so the same day
 * always gives the same rows (and the same checksum).
 */
export function uniteDayRows(
  appts: readonly SyncedAppointment[],
  opts: { day: string; timezone: string; statusMap: ReadonlyMap<string, PulseStatus | null> },
): DayRows {
  const inDay = appts
    .filter((a) => formatInTimeZone(new Date(a.startsAt), opts.timezone, "yyyy-MM-dd") === opts.day)
    .sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));

  const unmapped = new Set<string>();
  const rows: AppointmentRow[] = [];
  for (const a of inDay) {
    const code = a.externalStatus?.trim().toUpperCase() || "";
    const pulse = code ? opts.statusMap.get(code) : undefined;
    if (!pulse) {
      unmapped.add(code || "(blank)");
      continue;
    }
    const start = new Date(a.startsAt);
    const end = new Date(a.endsAt);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    const [hh, mm] = formatInTimeZone(start, opts.timezone, "HH:mm").split(":").map(Number);
    const doctor = a.doctorName?.trim() || null;
    rows.push({
      row_no: rows.length + 1,
      appointment_id: a.externalId,
      appt_date: opts.day,
      start_min: hh * 60 + mm,
      duration_min: a.endGiven && minutes >= 1 && minutes <= 1440 ? minutes : null,
      status: W2_STATUS[pulse],
      patient_pin: a.patientPin?.trim() || null,
      doctor_name: doctor ?? NO_DOCTOR_NAME,
      doctor_key: doctor ? normaliseDoctorKey(doctor) || NO_DOCTOR_KEY : NO_DOCTOR_KEY,
      clinic_name: a.clinicName,
      room: null,
    });
  }
  if (unmapped.size > 0)
    return { ok: false, reason: "unmapped_status", codes: [...unmapped].sort() };
  return { ok: true, rows };
}

/** The last `maxDays` finished days (yyyy-mm-dd in `timezone`), oldest first; today is never finished. */
export function finishedDays(now: Date, timezone: string, maxDays = 7): string[] {
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const t0 = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const days: string[] = [];
  for (let k = maxDays; k >= 1; k--)
    days.push(new Date(t0 - k * 86_400_000).toISOString().slice(0, 10));
  return days;
}

/** The finished days of the last `maxDays` this clinic has not settled yet, oldest first. */
export function daysToSettle(
  now: Date,
  timezone: string,
  settled: readonly string[],
  maxDays = 7,
): string[] {
  const done = new Set(settled);
  return finishedDays(now, timezone, maxDays).filter((d) => !done.has(d));
}

/** The settled-day list kept in the cursor: the union, newest `keep` days only. */
export function mergeSettled(
  settled: readonly string[],
  added: readonly string[],
  keep = 31,
): string[] {
  return [...new Set([...settled, ...added])]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .slice(-keep);
}

/** Reads the settled-day list from a sync cursor (anything malformed counts as nothing settled). */
export function settledOf(cursor: unknown): string[] {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return [];
  const list = (cursor as Record<string, unknown>).settled;
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
}
