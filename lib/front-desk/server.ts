import "server-only";

import { addDays, format as formatDate, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { effectiveVisitMode, type VisitMode } from "@/lib/integrations/telehealth/policy";

import { loadSlotInput } from "@/lib/appointments/availability";
import { generateSlots, localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import {
  cardFlags,
  pickLastVisit,
  pickNextAppointment,
  type CardAppointment,
  type CardFlag,
} from "@/lib/front-desk/patient-card";
import type { BoardAppointment, ReminderState } from "@/lib/front-desk/board";
import { withBranchFilter } from "@/lib/branches/filter";
import type { AdminClient } from "@/lib/supabase/admin";

/** [00:00 of the local date, 00:00 of the next day) as ISO instants. */
export function localDayRange(date: string, timezone: string): { gte: string; lt: string } {
  return {
    gte: localMinutesToInstant(date, 0, timezone).toISOString(),
    lt: localMinutesToInstant(date, 1440, timezone).toISOString(),
  };
}

export function todayIn(timezone: string, now: Date = new Date()): string {
  return localDate(now, timezone);
}

export function shiftDate(date: string, days: number): string {
  return formatDate(addDays(parseISO(`${date}T00:00:00`), days), "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// Today board
// ---------------------------------------------------------------------------

export type BoardRow = BoardAppointment & {
  ends_at: string;
  patient_name: string;
  phone: string | null;
  specialist_name: string | null;
  service_name: string | null;
  location_name: string | null;
  location_id: string | null;
  contact_language: string | null;
  with_doctor_at: string | null;
  done_at: string | null;
  checked_out_at: string | null;
  notes_present: boolean;
  /** Phase 19b: the visit's effective mode (the appointment's own, else its service's). */
  visit_mode: VisitMode;
};

type JoinedBoard = {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
  status: string;
  checkin_status: string | null;
  arrived_at: string | null;
  with_doctor_at: string | null;
  done_at: string | null;
  checked_out_at: string | null;
  is_walk_in: boolean;
  source: string;
  contact_id: string | null;
  specialist_id: string | null;
  location_id: string | null;
  notes: string | null;
  custom: unknown;
  contacts: { full_name: string | null; phone_e164: string | null; language: string | null } | null;
  specialists: { name: string } | null;
  visit_mode: string | null;
  services: { name: string; default_visit_mode: string | null } | null;
  locations: { name: string } | null;
  appointment_reminders: Array<{ status: string }>;
};

const REMINDER_ORDER: ReminderState[] = ["failed", "sent", "scheduled", "excluded", "cancelled"];

export function reminderStateOf(rows: Array<{ status: string }>): ReminderState {
  for (const s of REMINDER_ORDER) if (s && rows.some((r) => r.status === s)) return s;
  return null;
}

export async function loadBoardRows(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  date: string,
  locationId?: string | null,
  /** Phase B: the member's branch filter (lib/branches/server.ts branchView): those branches plus rows with none. */
  branchIds?: readonly string[] | null,
): Promise<BoardRow[]> {
  const range = localDayRange(date, timezone);
  let q = admin
    .from("appointments")
    .select(
      "id, number, starts_at, ends_at, status, checkin_status, arrived_at, with_doctor_at, done_at, checked_out_at, is_walk_in, source, contact_id, specialist_id, location_id, notes, custom, contacts(full_name, phone_e164, language), specialists(name), services(name, default_visit_mode), locations(name), appointment_reminders(status), visit_mode",
    )
    .eq("org_id", orgId)
    .gte("starts_at", range.gte)
    .lt("starts_at", range.lt)
    .order("starts_at")
    .limit(1000);
  if (locationId) q = q.eq("location_id", locationId);
  q = withBranchFilter(q, branchIds);
  const { data } = await q;
  return ((data ?? []) as unknown as JoinedBoard[]).map((a) => {
    const uniteName = (a.custom as Record<string, unknown> | null)?.unite_patient_name;
    return {
      id: a.id,
      number: a.number,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      status: a.status,
      checkin_status: a.checkin_status,
      arrived_at: a.arrived_at,
      with_doctor_at: a.with_doctor_at,
      done_at: a.done_at,
      checked_out_at: a.checked_out_at,
      is_walk_in: a.is_walk_in,
      source: a.source,
      contact_id: a.contact_id,
      specialist_id: a.specialist_id,
      location_id: a.location_id,
      reminder: reminderStateOf(a.appointment_reminders ?? []),
      patient_name:
        a.contacts?.full_name ||
        (typeof uniteName === "string" && uniteName ? uniteName : "Unmatched patient"),
      phone: a.contacts?.phone_e164 ?? null,
      contact_language: a.contacts?.language ?? null,
      specialist_name: a.specialists?.name ?? null,
      service_name: a.services?.name ?? null,
      location_name: a.locations?.name ?? null,
      notes_present: !!a.notes,
      visit_mode: effectiveVisitMode(a.visit_mode, a.services?.default_visit_mode),
    };
  });
}

// ---------------------------------------------------------------------------
// Next free slots per doctor
// ---------------------------------------------------------------------------

export type DoctorSlots = {
  specialist_id: string;
  specialist_name: string;
  location_id: string;
  location_name: string;
  /** The local date the slots are on (today, or the next day that has any). */
  date: string;
  slots: Array<{ starts_at: string; label: string }>;
};

/** The first few free slots per active specialist/location, looking ahead up to `lookAheadDays`. */
export async function loadNextFreeSlots(
  admin: AdminClient,
  orgId: string,
  opts: {
    today: string;
    durationMin: number;
    locationId?: string | null;
    /** Phase B: only these branches (null = no filter). Ignored when `locationId` is set. */
    locationIds?: readonly string[] | null;
    perDoctor?: number;
    lookAheadDays?: number;
  },
): Promise<DoctorSlots[]> {
  const perDoctor = opts.perDoctor ?? 4;
  const lookAhead = opts.lookAheadDays ?? 7;
  if (!opts.locationId && opts.locationIds && opts.locationIds.length === 0) return [];
  let q = admin
    .from("specialist_locations")
    .select(
      "specialist_id, location_id, specialists!inner(name, active), locations!inner(name, active)",
    )
    .eq("org_id", orgId)
    .eq("specialists.active", true)
    .eq("locations.active", true)
    .limit(60);
  if (opts.locationId) q = q.eq("location_id", opts.locationId);
  else if (opts.locationIds) q = q.in("location_id", [...opts.locationIds]);
  const { data: pairs } = await q;

  const out: DoctorSlots[] = [];
  for (const p of (pairs ?? []) as unknown as Array<{
    specialist_id: string;
    location_id: string;
    specialists: { name: string };
    locations: { name: string };
  }>) {
    for (let d = 0; d <= lookAhead; d++) {
      const date = shiftDate(opts.today, d);
      const input = await loadSlotInput(admin, {
        orgId,
        specialistId: p.specialist_id,
        locationId: p.location_id,
        date,
        durationMin: opts.durationMin,
        ignoreLeadTime: true,
      });
      if (!input) break;
      const slots = generateSlots(input).slice(0, perDoctor);
      if (slots.length) {
        out.push({
          specialist_id: p.specialist_id,
          specialist_name: p.specialists.name,
          location_id: p.location_id,
          location_name: p.locations.name,
          date,
          slots: slots.map((s) => ({ starts_at: s.start.toISOString(), label: s.label })),
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.specialist_name.localeCompare(b.specialist_name));
}

// ---------------------------------------------------------------------------
// Patient card
// ---------------------------------------------------------------------------

export type PatientCardData = {
  contact: {
    id: string;
    name: string;
    phone: string | null;
    has_bsuid: boolean;
    language: string | null;
    dob: string | null;
    stop_marketing: boolean;
  };
  next_appointment: CardAppointment | null;
  last_visit: CardAppointment | null;
  open_enquiry: { id: string; number: number; title: string; stage: string | null } | null;
  household: {
    guardian: { id: string; name: string; phone: string | null } | null;
    dependants: Array<{ id: string; link_id: string; name: string; next_starts_at: string | null }>;
  };
  open_call_tasks: number;
  waitlist: Array<{ id: string; specialist_name: string | null; service_name: string | null }>;
  flags: CardFlag[];
  now: string;
};

type ApptJoin = {
  id: string;
  number: number;
  starts_at: string;
  status: string;
  checkin_status: string | null;
  contact_id: string | null;
  specialists: { name: string } | null;
  services: { name: string } | null;
  locations: { name: string } | null;
};

export async function loadPatientCard(
  admin: AdminClient,
  orgId: string,
  contactId: string,
  now: Date = new Date(),
  /** Phase B: the branches the viewer may see (null = all); appointments, waiting list and enquiry keep to them. */
  branchIds: readonly string[] | null = null,
): Promise<PatientCardData | null> {
  const { data: contact } = await admin
    .from("contacts")
    .select("id, full_name, phone_e164, wa_bsuid, language, dob, stop_marketing, is_test_record")
    .eq("id", contactId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return null;

  const [{ data: guardianLink }, { data: dependantLinks }] = await Promise.all([
    admin
      .from("household_links")
      .select(
        "guardian:contacts!household_links_guardian_contact_id_fkey(id, full_name, phone_e164)",
      )
      .eq("org_id", orgId)
      .eq("dependant_contact_id", contactId)
      .maybeSingle(),
    admin
      .from("household_links")
      .select("id, dependant:contacts!household_links_dependant_contact_id_fkey(id, full_name)")
      .eq("org_id", orgId)
      .eq("guardian_contact_id", contactId),
  ]);
  const g =
    (guardianLink?.guardian as {
      id: string;
      full_name: string | null;
      phone_e164: string | null;
    } | null) ?? null;
  const guardian = g ? { id: g.id, full_name: g.full_name ?? "", phone: g.phone_e164 } : null;
  const dependants = (
    (dependantLinks ?? []) as unknown as Array<{
      id: string;
      dependant: { id: string; full_name: string | null } | null;
    }>
  )
    .filter(
      (l): l is typeof l & { dependant: { id: string; full_name: string | null } } => !!l.dependant,
    )
    .map((l) => ({ id: l.dependant.id, link_id: l.id, full_name: l.dependant.full_name ?? "" }));

  const ids = [contactId, ...dependants.map((d) => d.id)];
  const yearAgo = new Date(now.getTime() - 365 * 24 * 3600_000).toISOString();
  const [
    { data: appts },
    { data: enquiry },
    { count: openCalls },
    { data: waits },
    { count: noShows },
  ] = await Promise.all([
    withBranchFilter(
      admin
        .from("appointments")
        .select(
          "id, number, starts_at, status, checkin_status, contact_id, specialists(name), services(name), locations(name)",
        )
        .eq("org_id", orgId)
        .in("contact_id", ids)
        .gte("starts_at", yearAgo),
      branchIds,
    )
      .order("starts_at", { ascending: false })
      .limit(200),
    withBranchFilter(
      admin
        .from("enquiries")
        .select("id, number, title, stages(name)")
        .eq("org_id", orgId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .is("deleted_at", null),
      branchIds,
    )
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .eq("type", "call")
      .eq("done", false)
      .is("deleted_at", null),
    withBranchFilter(
      admin
        .from("waitlist_entries")
        .select("id, specialists(name), services(name)")
        .eq("org_id", orgId)
        .eq("contact_id", contactId)
        .eq("status", "waiting"),
      branchIds,
    ),
    withBranchFilter(
      admin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("contact_id", contactId)
        .eq("status", "no_show")
        .gte("starts_at", yearAgo),
      branchIds,
    ),
  ]);

  const nameOf = new Map<string, string>([
    [contactId, contact.full_name ?? ""],
    ...dependants.map((d) => [d.id, d.full_name ?? ""] as [string, string]),
  ]);
  const rows: CardAppointment[] = ((appts ?? []) as unknown as ApptJoin[]).map((a) => ({
    id: a.id,
    number: a.number,
    starts_at: a.starts_at,
    status: a.status,
    checkin_status: a.checkin_status,
    specialist_name: a.specialists?.name ?? null,
    service_name: a.services?.name ?? null,
    location_name: a.locations?.name ?? null,
    patient_id: a.contact_id,
    patient_name:
      a.contact_id && a.contact_id !== contactId ? (nameOf.get(a.contact_id) ?? null) : null,
  }));
  const own = rows.filter((r) => !r.patient_id || r.patient_id === contactId);
  const next = pickNextAppointment(rows, now);
  const last = pickLastVisit(own, now);

  const dependantNext = new Map<string, string>();
  for (const r of rows) {
    if (
      r.patient_id &&
      r.patient_id !== contactId &&
      !["cancelled", "no_show", "completed"].includes(r.status) &&
      new Date(r.starts_at) >= now
    ) {
      const prev = dependantNext.get(r.patient_id);
      if (!prev || r.starts_at < prev) dependantNext.set(r.patient_id, r.starts_at);
    }
  }

  const waitlist = (
    (waits ?? []) as unknown as Array<{
      id: string;
      specialists: { name: string } | null;
      services: { name: string } | null;
    }>
  ).map((w) => ({
    id: w.id,
    specialist_name: w.specialists?.name ?? null,
    service_name: w.services?.name ?? null,
  }));

  return {
    contact: {
      id: contact.id,
      name: contact.full_name || "Unnamed patient",
      phone: contact.phone_e164,
      has_bsuid: !!contact.wa_bsuid,
      language: contact.language,
      dob: contact.dob,
      stop_marketing: contact.stop_marketing,
    },
    next_appointment: next,
    last_visit: last,
    open_enquiry: enquiry
      ? {
          id: enquiry.id,
          number: enquiry.number,
          title: enquiry.title,
          stage: (enquiry.stages as { name: string } | null)?.name ?? null,
        }
      : null,
    household: {
      guardian: guardian
        ? { id: guardian.id, name: guardian.full_name, phone: guardian.phone }
        : null,
      dependants: dependants.map((d) => ({
        id: d.id,
        link_id: d.link_id,
        name: d.full_name,
        next_starts_at: dependantNext.get(d.id) ?? null,
      })),
    },
    open_call_tasks: openCalls ?? 0,
    waitlist,
    flags: cardFlags({
      stop_marketing: contact.stop_marketing,
      has_phone: !!contact.phone_e164,
      has_bsuid: !!contact.wa_bsuid,
      dob: contact.dob,
      no_shows_12m: noShows ?? 0,
      open_call_tasks: openCalls ?? 0,
      waitlist_entries: waitlist.length,
      guardian: guardian ? { id: guardian.id, name: guardian.full_name } : null,
      dependants: dependants.length,
      is_test_record: contact.is_test_record,
    }),
    now: now.toISOString(),
  };
}

export function formatCardTime(iso: string, timezone: string): { date: string; time: string } {
  return {
    date: formatInTimeZone(new Date(iso), timezone, "EEE d MMM"),
    time: formatInTimeZone(new Date(iso), timezone, "h:mm a"),
  };
}
