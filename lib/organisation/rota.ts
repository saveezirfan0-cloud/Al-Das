/**
 * Rota rules (pure; unit-tested). A shift is entered as a local date plus start and end times in the branch's
 * timezone and stored as UTC instants. An end time at or before the start means the shift runs past midnight.
 *
 * The overlap rule is the database's (app.rota_shifts_no_overlap: same person, start < other end and end > other start;
 * touching shifts are fine). `findOverlap` mirrors it so the dialog can warn early; the database stays the source of
 * truth and refuses an overlap that slips through (two people saving at once).
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { addDays, dayNumber } from "@/lib/documents/expiry";

export const ROTA_ROLES = ["front_desk", "doctor", "nurse", "other"] as const;
export type RotaRole = (typeof ROTA_ROLES)[number];

export const ROTA_ROLE_LABELS: Record<RotaRole, string> = {
  front_desk: "Front desk",
  doctor: "Doctor",
  nurse: "Nurse",
  other: "Other",
};

export function isRotaRole(v: unknown): v is RotaRole {
  return typeof v === "string" && (ROTA_ROLES as readonly string[]).includes(v);
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ShiftRange = { startsAt: string; endsAt: string };

/**
 * The UTC instants of a shift entered as date + times in `timezone`. Null for a bad date or time, an empty shift, or
 * one longer than 24 hours (the table refuses those too).
 */
export function shiftRange(
  date: string,
  start: string,
  end: string,
  timezone: string,
): ShiftRange | null {
  if (dayNumber(date) === null || !TIME.test(start) || !TIME.test(end)) return null;
  const endDate = end <= start ? addDays(date, 1) : date;
  if (!endDate) return null;
  const s = fromZonedTime(`${date}T${start}:00`, timezone);
  const e = fromZonedTime(`${endDate}T${end}:00`, timezone);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  const ms = e.getTime() - s.getTime();
  if (ms <= 0 || ms > 24 * 3_600_000) return null;
  return { startsAt: s.toISOString(), endsAt: e.toISOString() };
}

/** Do two half-open ranges [start, end) overlap? Touching ends do not. */
export function rangesOverlap(a: ShiftRange, b: ShiftRange): boolean {
  return (
    Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(a.endsAt) > Date.parse(b.startsAt)
  );
}

export type RotaShiftLike = ShiftRange & { id: string; staffMemberId: string };

/** The first existing shift of the same person that overlaps the candidate (ignoring the shift being edited). */
export function findOverlap<T extends RotaShiftLike>(
  shifts: readonly T[],
  candidate: RotaShiftLike,
): T | null {
  return (
    shifts.find(
      (s) =>
        s.staffMemberId === candidate.staffMemberId &&
        s.id !== candidate.id &&
        rangesOverlap(s, candidate),
    ) ?? null
  );
}

/** Monday of the week that holds `date` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(date: string): string | null {
  const n = dayNumber(date);
  if (n === null) return null;
  // Day 0 (1970-01-01) was a Thursday: ISO weekday = ((n + 3) mod 7) + 1, Monday = 1.
  const isoWeekday = (((n + 3) % 7) + 7) % 7;
  return addDays(date, -isoWeekday);
}

/** The seven dates of the week starting `monday`. */
export function weekDays(monday: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    if (d) out.push(d);
  }
  return out;
}

/** The local date a shift starts on in `timezone` (the column it sits in on the week grid). */
export function shiftLocalDate(startsAt: string, timezone: string): string {
  return formatInTimeZone(new Date(startsAt), timezone, "yyyy-MM-dd");
}

/** "09:00–13:00" in `timezone`; "22:00–06:00 (+1)" for a shift that ends the next day. */
export function shiftLabel(shift: ShiftRange, timezone: string): string {
  const s = new Date(shift.startsAt);
  const e = new Date(shift.endsAt);
  const sd = formatInTimeZone(s, timezone, "yyyy-MM-dd");
  const ed = formatInTimeZone(e, timezone, "yyyy-MM-dd");
  const text = `${formatInTimeZone(s, timezone, "HH:mm")}–${formatInTimeZone(e, timezone, "HH:mm")}`;
  return sd === ed ? text : `${text} (+1)`;
}

/** The local start and end times of a stored shift, for the edit dialog. */
export function shiftTimes(
  shift: ShiftRange,
  timezone: string,
): { date: string; start: string; end: string } {
  return {
    date: formatInTimeZone(new Date(shift.startsAt), timezone, "yyyy-MM-dd"),
    start: formatInTimeZone(new Date(shift.startsAt), timezone, "HH:mm"),
    end: formatInTimeZone(new Date(shift.endsAt), timezone, "HH:mm"),
  };
}

/** The UTC window a week view loads: from Monday 00:00 to the next Monday 00:00 in `timezone`. */
export function weekWindow(monday: string, timezone: string): { from: string; to: string } | null {
  const next = addDays(monday, 7);
  if (dayNumber(monday) === null || !next) return null;
  return {
    from: fromZonedTime(`${monday}T00:00:00`, timezone).toISOString(),
    to: fromZonedTime(`${next}T00:00:00`, timezone).toISOString(),
  };
}
