import "server-only";

import { addDays, format, parseISO } from "date-fns";

import { readAppointmentSettings } from "@/lib/appointments/settings";
import {
  expandRecurringBlocks,
  generateSlots,
  localDate,
  localMinutesToInstant,
  shiftLocalDate,
  slotFits,
  type BusyInterval,
  type RecurringBlockRow,
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
  /**
   * The service being booked: its buffers and concurrent patients apply. Without one (front-desk walk-in
   * overview) there are no own buffers and one place.
   */
  serviceId?: string | null;
  /** An appointment being rescheduled does not block its own slot. */
  excludeAppointmentId?: string;
  now?: Date;
  /** Staff-facing lists ignore the patient lead time (but still hide the past). */
  ignoreLeadTime?: boolean;
};

type BusyContext = {
  busy: BusyInterval[];
  recurringBlocks: RecurringBlockRow[];
  /** least(service capacity, specialist max per slot) for the candidate. */
  capacity: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Specialist's own slot length (null = org default). */
  slotLengthMin: number | null;
};

/**
 * Everything that occupies a specialist between two instants: their appointments at every location (one
 * person cannot be in two places) with each booking's buffers and places, the one-off blocks that apply to
 * this location, and their weekly blocks. Plus the candidate service's buffers and places.
 */
async function loadBusyContext(
  admin: AdminClient,
  q: {
    orgId: string;
    specialistId: string;
    locationId: string;
    serviceId?: string | null;
    from: string;
    to: string;
    excludeAppointmentId?: string;
  },
): Promise<BusyContext> {
  const [{ data: specialist }, { data: service }, appts, blocks, weekly] = await Promise.all([
    admin
      .from("specialists")
      .select("max_per_slot, slot_length_min")
      .eq("id", q.specialistId)
      .eq("org_id", q.orgId)
      .maybeSingle(),
    q.serviceId
      ? admin
          .from("services")
          .select("buffer_before_min, buffer_after_min, capacity")
          .eq("id", q.serviceId)
          .eq("org_id", q.orgId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("appointments")
      .select("id, starts_at, ends_at, services(buffer_before_min, buffer_after_min, capacity)")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .in("status", ["awaiting", "confirmed", "completed"])
      .lt("starts_at", q.to)
      .gt("ends_at", q.from),
    admin
      .from("time_blocks")
      .select("starts_at, ends_at, location_id")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .lt("starts_at", q.to)
      .gt("ends_at", q.from),
    admin
      .from("specialist_recurring_blocks")
      .select("weekday, start_min, end_min, location_id")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId),
  ]);
  const maxPerSlot = specialist?.max_per_slot ?? 1;
  type Joined = {
    id: string;
    starts_at: string;
    ends_at: string;
    services: { buffer_before_min: number; buffer_after_min: number; capacity: number } | null;
  };
  const busy: BusyInterval[] = [
    ...((appts.data ?? []) as unknown as Joined[])
      .filter((a) => a.id !== q.excludeAppointmentId)
      .map((a) => ({
        start: new Date(a.starts_at),
        end: new Date(a.ends_at),
        bufferBeforeMin: a.services?.buffer_before_min ?? 0,
        bufferAfterMin: a.services?.buffer_after_min ?? 0,
        capacity: Math.min(a.services?.capacity ?? 1, maxPerSlot),
        kind: "booking" as const,
      })),
    ...(blocks.data ?? [])
      .filter((b) => !b.location_id || b.location_id === q.locationId)
      .map((b) => ({
        start: new Date(b.starts_at),
        end: new Date(b.ends_at),
        kind: "block" as const,
      })),
  ];
  return {
    busy,
    recurringBlocks: (weekly.data ?? [])
      .filter((r) => !r.location_id || r.location_id === q.locationId)
      .map((r) => ({ weekday: r.weekday, start_min: r.start_min, end_min: r.end_min })),
    capacity: Math.min(service?.capacity ?? 1, maxPerSlot),
    bufferBeforeMin: service?.buffer_before_min ?? 0,
    bufferAfterMin: service?.buffer_after_min ?? 0,
    slotLengthMin: specialist?.slot_length_min ?? null,
  };
}

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

  // The local day as instants; a 12h margin each side catches overnight blocks and buffers in any timezone.
  const dayStart = localMinutesToInstant(q.date, 0, location.timezone);
  const dayEnd = localMinutesToInstant(q.date, 1440, location.timezone);
  const from = new Date(dayStart.getTime() - 12 * 3600_000).toISOString();
  const to = new Date(dayEnd.getTime() + 12 * 3600_000).toISOString();

  const [{ data: hours }, ctx] = await Promise.all([
    admin
      .from("working_hours")
      .select("weekday, start_min, end_min")
      .eq("org_id", q.orgId)
      .eq("specialist_id", q.specialistId)
      .eq("location_id", q.locationId),
    loadBusyContext(admin, { ...q, from, to }),
  ]);

  return {
    date: q.date,
    timezone: location.timezone,
    durationMin: q.durationMin,
    granularityMin: ctx.slotLengthMin ?? settings.slot_granularity_min,
    workingHours: hours ?? [],
    busy: ctx.busy,
    now: q.now ?? new Date(),
    leadTimeMin: q.ignoreLeadTime ? 0 : settings.lead_time_minutes,
    workingWeekdays: settings.working_weekdays,
    holidays: settings.holidays,
    bufferBeforeMin: ctx.bufferBeforeMin,
    bufferAfterMin: ctx.bufferAfterMin,
    capacity: ctx.capacity,
    recurringBlocks: ctx.recurringBlocks,
  };
}

/**
 * The slot list for one day. `includeTaken` (ShowBusy, G6) also lists the refused slots inside working hours, marked
 * `taken` with a display reason; the caller decides from the org's `show_busy` booking setting.
 */
export async function slotsForDay(
  admin: AdminClient,
  q: DayQuery,
  opts: { includeTaken?: boolean } = {},
): Promise<Slot[]> {
  const input = await loadSlotInput(admin, q);
  return input ? generateSlots(input, { includeTaken: !!opts.includeTaken }) : [];
}

/**
 * Does one exact interval still have a place (blocks, weekly blocks, buffers, capacity)? No working hours or
 * lead time: used for a slot that already existed (a freed appointment offered to the waiting list).
 */
export async function intervalHasPlace(
  admin: AdminClient,
  q: {
    orgId: string;
    specialistId: string;
    locationId: string;
    serviceId?: string | null;
    start: Date;
    end: Date;
    excludeAppointmentId?: string;
  },
): Promise<boolean> {
  const { data: location } = await admin
    .from("locations")
    .select("timezone")
    .eq("id", q.locationId)
    .eq("org_id", q.orgId)
    .maybeSingle();
  if (!location) return false;
  const margin = 12 * 3600_000;
  const ctx = await loadBusyContext(admin, {
    ...q,
    from: new Date(q.start.getTime() - margin).toISOString(),
    to: new Date(q.end.getTime() + margin).toISOString(),
  });
  const weekly = expandRecurringBlocks(
    ctx.recurringBlocks,
    shiftLocalDate(localDate(q.start, location.timezone), -1),
    shiftLocalDate(localDate(q.end, location.timezone), 1),
    location.timezone,
  );
  return slotFits(
    {
      start: q.start,
      end: q.end,
      bufferBeforeMin: ctx.bufferBeforeMin,
      bufferAfterMin: ctx.bufferAfterMin,
      capacity: ctx.capacity,
    },
    [...ctx.busy, ...weekly],
  );
}

/** YYYY-MM-DD → the next calendar day. */
export function nextDate(date: string): string {
  return format(addDays(parseISO(`${date}T00:00:00`), 1), "yyyy-MM-dd");
}
