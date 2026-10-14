/**
 * Booking from the desk (Phase E, pure): which doctors to show for a branch and service, and how one day of their free
 * times is laid out. The times themselves come from the slot engine (generateSlots / slotFits, the one rule); this file
 * only filters and orders what the engine returned. The booking goes through public.book_appointment (per-doctor lock).
 */
import { daysUntil } from "@/lib/documents/expiry";

export type BookDoctor = {
  id: string;
  name: string;
  location_ids: readonly string[];
  service_ids: readonly string[];
};

/** Doctors who work at the branch and do the service (a doctor with no services listed does none). */
export function doctorsForBooking<T extends BookDoctor>(
  doctors: readonly T[],
  locationId: string | null | undefined,
  serviceId: string | null | undefined,
): T[] {
  if (!locationId || !serviceId) return [];
  return doctors
    .filter((d) => d.location_ids.includes(locationId) && d.service_ids.includes(serviceId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Services at least one of the branch's doctors offers, so the picker never offers something nobody does there. */
export function servicesAtBranch<S extends { id: string }>(
  services: readonly S[],
  doctors: readonly BookDoctor[],
  locationId: string | null | undefined,
): S[] {
  if (!locationId) return [];
  const offered = new Set(
    doctors.filter((d) => d.location_ids.includes(locationId)).flatMap((d) => d.service_ids),
  );
  return services.filter((s) => offered.has(s.id));
}

/** The branch the drawer opens on: the switcher's (or home) branch when the member may book there, else their only one. */
export function presetBranch(
  locations: ReadonlyArray<{ id: string }>,
  current: string | null | undefined,
): string | null {
  if (current && locations.some((l) => l.id === current)) return current;
  return locations.length === 1 ? locations[0].id : null;
}

export type DaySlot = { start: string; label: string };
export type DoctorDay = { specialist_id: string; name: string; slots: DaySlot[] };

/**
 * One day of free times per doctor, ready to show: times already in the past are dropped (a slot the engine offered a
 * minute ago may have passed), doctors with nothing left are listed last as "no free time", and the rest are ordered by
 * their first free time, then name. `limit` caps the buttons per doctor.
 */
export function dayPlan(
  rows: readonly DoctorDay[],
  now: Date,
  limit = 24,
): { open: DoctorDay[]; full: Array<{ specialist_id: string; name: string }> } {
  const cutoff = now.getTime();
  const trimmed = rows.map((r) => ({
    ...r,
    slots: r.slots.filter((s) => new Date(s.start).getTime() > cutoff).slice(0, limit),
  }));
  const open = trimmed
    .filter((r) => r.slots.length > 0)
    .sort(
      (a, b) =>
        new Date(a.slots[0].start).getTime() - new Date(b.slots[0].start).getTime() ||
        a.name.localeCompare(b.name),
    );
  const full = trimmed
    .filter((r) => r.slots.length === 0)
    .map((r) => ({ specialist_id: r.specialist_id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { open, full };
}

/** A date the desk may book: a real calendar date from today up to 90 days ahead (YYYY-MM-DD). */
export function bookableDate(date: string, today: string, maxAheadDays = 90): boolean {
  const diff = daysUntil(date, today);
  return diff !== null && diff >= 0 && diff <= maxAheadDays;
}
