import "server-only";

import { addDays, format, parseISO } from "date-fns";

import { readAppointmentSettings } from "@/lib/appointments/settings";
import {
  generateSlots,
  localMinutesToInstant,
  type BusyInterval,
  type Slot,
  type SlotInput,
} from "@/lib/appointments/slots";
import type { AdminClient } from "@/lib/supabase/admin";

export type DayQuery = {
  orgId: string;
  specialistId: string;
  locationId: string;
  /** Local date at the location: YYYY-MM-DD. */
  date: string;
  durationMin: number;
  /** An appointment being rescheduled does not block its own slot. */
  excludeAppointmentId?: string;
  now?: Date;
  /** Staff-facing lists ignore the patient lead time (but still hide the past). */
  ignoreLeadTime?: boolean;
};

/** Loads everything the slot engine needs for one specialist / location / day. */
export async function loadSlotInput(admin: AdminClient, q: DayQuery): Promise<SlotInput | null> {
  const [{ data: location }, { data: org }] = await Promise.all([
    admin
      .from("locations")
      .select("id, timezone")
      .eq("id", q.locationId)
      .eq("org_id", q.orgId)
      .maybeSingle(),
    admin.from("orgs").select("settings").eq("id", q.orgId).single(),
  ]);
  if (!location) return null;
  const settings = readAppointmentSettings(org?.settings);

  // The local day as instants; a 12h margin each side catches overnight blocks in any timezone.
  const dayStart = localMinutesToInstant(q.date, 0, location.timezone);
  const dayEnd = localMinutesToInstant(q.date, 1440, location.timezone);
  const from = new Date(dayStart.getTime() - 12 * 3600_000).toISOString();
  const to = new Date(dayEnd.getTime() + 12 * 3600_000).toISOString();

  const [hours, appts, blocks] = await Promise.all([
    admin
      .from("working_hours")
      .select("weekday, start_min, end_min")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .eq("location_id", q.locationId),
    // A specialist can't be in two places: appointments at every location block the slot.
    admin
      .from("appointments")
      .select("id, starts_at, ends_at")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .in("status", ["awaiting", "confirmed", "completed"])
      .lt("starts_at", to)
      .gt("ends_at", from),
    admin
      .from("time_blocks")
      .select("starts_at, ends_at, location_id")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .lt("starts_at", to)
      .gt("ends_at", from),
  ]);

  const busy: BusyInterval[] = [
    ...(appts.data ?? [])
      .filter((a) => a.id !== q.excludeAppointmentId)
      .map((a) => ({ start: new Date(a.starts_at), end: new Date(a.ends_at) })),
    ...(blocks.data ?? [])
      .filter((b) => !b.location_id || b.location_id === q.locationId)
      .map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) })),
  ];

  return {
    date: q.date,
    timezone: location.timezone,
    durationMin: q.durationMin,
    granularityMin: settings.slot_granularity_min,
    workingHours: hours.data ?? [],
    busy,
    now: q.now ?? new Date(),
    leadTimeMin: q.ignoreLeadTime ? 0 : settings.lead_time_minutes,
    workingWeekdays: settings.working_weekdays,
    holidays: settings.holidays,
  };
}

export async function slotsForDay(admin: AdminClient, q: DayQuery): Promise<Slot[]> {
  const input = await loadSlotInput(admin, q);
  return input ? generateSlots(input) : [];
}

/** YYYY-MM-DD → the next calendar day. */
export function nextDate(date: string): string {
  return format(addDays(parseISO(`${date}T00:00:00`), 1), "yyyy-MM-dd");
}
