import { createHash } from "node:crypto";

import { fromZonedTime } from "date-fns-tz";

/**
 * Pure rules of the Google Calendar busy sync.
 *
 * OUT: an appointment becomes an event with a FIXED shape: the title "Busy", start, end, opaque, private, no reminders and a
 * private marker so the sync can recognise its own events when it reads the calendar back. buildBusyEvent() takes only a start
 * and an end, so no patient name, service, note, phone, location or id can ever reach Google (a test passes hostile extras).
 *
 * IN: the calendar's events become busy blocks keyed by a hash of the Google event id. Only start, end, status, transparency and
 * the marker are read (the API request asks for no other field): never a title, description, attendee or location.
 */

/** Statuses during which a specialist is busy with an appointment. */
export const BUSY_STATUSES = new Set(["awaiting", "confirmed", "completed"]);

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Pulse chooses the Google event id itself (base32hex alphabet a-v and 0-9, 5 to 1024 characters), derived from the organisation and
 * appointment, so an insert repeated after a lost answer finds the same event instead of creating a second one.
 */
export function gcalEventId(orgId: string, appointmentId: string): string {
  return `pulse${sha256(`${orgId}:${appointmentId}`).slice(0, 48)}`;
}

export const PULSE_MARKER = { key: "pulse", value: "1" } as const;

export type BusyEvent = {
  summary: "Busy";
  start: { dateTime: string };
  end: { dateTime: string };
  transparency: "opaque";
  visibility: "private";
  status: "confirmed";
  reminders: { useDefault: false; overrides: [] };
  extendedProperties: { private: { pulse: "1" } };
};

/** The ONLY event body Pulse sends to Google. Extra properties on the input are ignored by construction. */
export function buildBusyEvent(a: { startsAt: string; endsAt: string }): BusyEvent {
  const start = new Date(a.startsAt);
  const end = new Date(a.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start)
    throw new Error("invalid appointment times");
  return {
    summary: "Busy",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    transparency: "opaque",
    visibility: "private",
    status: "confirmed",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { pulse: "1" } },
  };
}

/** What was last written for an appointment; a change of time (or of busy-ness) means it must be written again. */
export function syncHash(a: { startsAt: string; endsAt: string; busy: boolean }): string {
  return sha256(
    `${new Date(a.startsAt).toISOString()}|${new Date(a.endsAt).toISOString()}|${a.busy ? 1 : 0}`,
  );
}

export type ApptForSync = {
  id: string;
  specialistId: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
};

export type LinkForSync = {
  appointmentId: string | null;
  eventId: string;
  syncedHash: string;
  status: "live" | "deleted";
};

export type PushPlan = {
  upsert: Array<{
    appointmentId: string;
    eventId: string;
    startsAt: string;
    endsAt: string;
    hash: string;
    known: boolean;
  }>;
  remove: Array<{ eventId: string; appointmentId: string | null }>;
};

/**
 * Which events to write and which to delete for one specialist. `appointments` must hold the specialist's appointments inside the
 * sync window AND every appointment a live link points at (wherever it is now), so a link whose appointment is merely outside the
 * window is left alone while one whose appointment was cancelled, moved to another doctor or deleted is removed. With `enabled`
 * false (pushing switched off) every live event is removed.
 */
export function planPush(a: {
  orgId: string;
  specialistId: string;
  window: { from: Date; to: Date };
  appointments: readonly ApptForSync[];
  links: readonly LinkForSync[];
  enabled: boolean;
}): PushPlan {
  const plan: PushPlan = { upsert: [], remove: [] };
  const byAppt = new Map(a.appointments.map((x) => [x.id, x]));
  const linkByAppt = new Map(
    a.links.filter((l) => l.appointmentId && l.status === "live").map((l) => [l.appointmentId!, l]),
  );
  const inWindow = (x: ApptForSync) =>
    new Date(x.endsAt) > a.window.from && new Date(x.startsAt) < a.window.to;
  const wanted = (x: ApptForSync) =>
    a.enabled && x.specialistId === a.specialistId && BUSY_STATUSES.has(x.status);

  for (const x of a.appointments) {
    if (!wanted(x) || !inWindow(x)) continue;
    const hash = syncHash({ startsAt: x.startsAt, endsAt: x.endsAt, busy: true });
    const link = linkByAppt.get(x.id);
    if (link && link.syncedHash === hash) continue;
    plan.upsert.push({
      appointmentId: x.id,
      eventId: link?.eventId ?? gcalEventId(a.orgId, x.id),
      startsAt: x.startsAt,
      endsAt: x.endsAt,
      hash,
      known: !!link,
    });
  }
  for (const l of a.links) {
    if (l.status !== "live") continue;
    const x = l.appointmentId ? byAppt.get(l.appointmentId) : undefined;
    if (x && wanted(x)) continue; // still busy (inside the window it was handled above; outside it is left alone)
    plan.remove.push({ eventId: l.eventId, appointmentId: l.appointmentId });
  }
  return plan;
}

export type GoogleEventLike = {
  id?: unknown;
  status?: unknown;
  transparency?: unknown;
  start?: { dateTime?: unknown; date?: unknown } | null;
  end?: { dateTime?: unknown; date?: unknown } | null;
  extendedProperties?: { private?: Record<string, unknown> | null } | null;
};

export type BusyBlock = { key: string; starts_at: string; ends_at: string };

function when(
  t: { dateTime?: unknown; date?: unknown } | null | undefined,
  timeZone: string,
): Date | null {
  if (!t) return null;
  if (typeof t.dateTime === "string") {
    const d = new Date(t.dateTime);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
    const d = fromZonedTime(`${t.date}T00:00:00`, timeZone);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/** Is this one of the "Busy" events Pulse itself wrote (so it must not come back in as a block)? */
export function isPulseEvent(e: GoogleEventLike): boolean {
  const priv = e.extendedProperties?.private;
  return (
    (priv && priv[PULSE_MARKER.key] === PULSE_MARKER.value) ||
    (typeof e.id === "string" && /^pulse[0-9a-f]{48}$/.test(e.id))
  );
}

/**
 * Busy blocks from the calendar's events (all-day events in the clinic's time zone). Skips cancelled and "free" (transparent)
 * events and Pulse's own events. The key is a hash of the event id, so reading the same calendar twice gives the same blocks.
 */
export function busyBlocksFromEvents(
  events: readonly GoogleEventLike[],
  timeZone: string,
): BusyBlock[] {
  const out = new Map<string, BusyBlock>();
  for (const e of events) {
    if (typeof e.id !== "string" || !e.id || e.id.length > 1024) continue;
    if (e.status === "cancelled" || e.transparency === "transparent" || isPulseEvent(e)) continue;
    const start = when(e.start, timeZone);
    const end = when(e.end, timeZone);
    if (!start || !end || end <= start) continue;
    const key = sha256(`gcal:${e.id}`);
    out.set(key, { key, starts_at: start.toISOString(), ends_at: end.toISOString() });
  }
  return [...out.values()].slice(0, 2000);
}
