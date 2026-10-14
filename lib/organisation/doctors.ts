/**
 * Doctors directory (Phase C): pure helpers for the list and the drawer. Doctors are `specialists`; their working
 * hours stay edited under Settings, Appointments, and are only summarised here.
 */
import { z } from "zod";

import { dayNumber } from "@/lib/documents/expiry";

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type HoursRow = { location_id: string; weekday: number; start_min: number; end_min: number };

function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * One line per branch, e.g. "Mon 09:00–13:00, 14:00–18:00 · Wed 09:00–17:00". Days in ISO order (Monday first),
 * times sorted. Branches without hours are left out.
 */
export function hoursSummary(
  hours: readonly HoursRow[],
  locations: ReadonlyArray<{ id: string; name: string }>,
): Array<{ locationId: string; locationName: string; text: string }> {
  const out: Array<{ locationId: string; locationName: string; text: string }> = [];
  for (const loc of locations) {
    const mine = hours.filter((h) => h.location_id === loc.id);
    if (mine.length === 0) continue;
    const days: string[] = [];
    for (let d = 1; d <= 7; d++) {
      const spans = mine
        .filter((h) => h.weekday === d)
        .sort((a, b) => a.start_min - b.start_min)
        .map((h) => `${hhmm(h.start_min)}–${hhmm(h.end_min)}`);
      if (spans.length) days.push(`${WEEKDAY[d]} ${spans.join(", ")}`);
    }
    out.push({ locationId: loc.id, locationName: loc.name, text: days.join(" · ") });
  }
  return out;
}

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    });

/** The profile and licence fields an HR or settings manager may edit on a doctor (no patient data). */
export const doctorProfileSchema = z.object({
  specialty: optionalText(100),
  licence_number: optionalText(60),
  licence_authority: z
    .string()
    .max(20)
    .nullish()
    .transform((v) => (v?.trim() ? v.trim() : "DHA")),
  licence_expires_on: z
    .string()
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .refine((v) => v === null || dayNumber(v) !== null, "Use a real date (YYYY-MM-DD)."),
  phone_ext: optionalText(6).refine(
    (v) => v === null || /^[0-9]{1,6}$/.test(v),
    "The extension is digits only (up to 6).",
  ),
  bio: optionalText(500),
});
export type DoctorProfileInput = z.input<typeof doctorProfileSchema>;

/** The diary link for one doctor: the calendar view, opened on that doctor (the appointments page reads both). */
export function doctorCalendarHref(specialistId: string): string {
  return `/appointments?view=calendar&specialist=${encodeURIComponent(specialistId)}`;
}

/**
 * How the doctor drawer names a patient: the first name for someone who may open patient records, initials for
 * everyone else, "Patient" when there is no usable name (or the record was deleted). Never the full name.
 */
export function patientShortName(
  fullName: string | null | undefined,
  showFirstName: boolean,
): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Patient";
  if (showFirstName) return words[0];
  const ends = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return ends.map((w) => `${Array.from(w)[0]!.toUpperCase()}.`).join(" ");
}
