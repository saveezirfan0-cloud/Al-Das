"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { slotsForDay } from "@/lib/appointments/availability";
import {
  changeAppointmentStatus,
  createAppointment,
  createTimeBlock,
  rescheduleAppointment,
  sendAppointmentTemplate,
} from "@/lib/appointments/service";
import { localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import { APPOINTMENT_STATUSES, isAppointmentStatus } from "@/lib/appointments/status";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { toCsv } from "@/lib/csv";
import { formatPhone } from "@/lib/phone";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

import type {
  ApptDetail,
  ApptRow,
  BlockRow,
  ListQuery,
  ReminderSummary,
  SlotOption,
} from "./types";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function refresh() {
  revalidatePath("/appointments");
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const APPT_SELECT =
  "*, contacts(full_name, phone_e164), channels(name), appointment_reminders(status)";

type JoinedAppointment = Tables<"appointments"> & {
  contacts: { full_name: string; phone_e164: string | null } | null;
  channels: { name: string } | null;
  appointment_reminders: Array<{ status: string }>;
};

function summariseReminders(rows: Array<{ status: string }>): ReminderSummary {
  const has = (s: string) => rows.some((r) => r.status === s);
  for (const s of ["failed", "sent", "scheduled", "excluded", "cancelled"] as const)
    if (has(s)) return s;
  return null;
}

function toRow(a: JoinedAppointment): ApptRow {
  const uniteName = (a.custom as Record<string, unknown> | null)?.unite_patient_name;
  return {
    id: a.id,
    number: a.number,
    contact_id: a.contact_id,
    contact_name:
      a.contacts?.full_name ||
      (typeof uniteName === "string" && uniteName ? uniteName : "Unmatched patient"),
    phone: a.contacts?.phone_e164 ? formatPhone(a.contacts.phone_e164) : null,
    status: isAppointmentStatus(a.status) ? a.status : "awaiting",
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    location_id: a.location_id,
    specialist_id: a.specialist_id,
    service_id: a.service_id,
    department_id: a.department_id,
    channel_name: a.channels?.name ?? null,
    source: a.source,
    external_id: a.external_id,
    notes: a.notes,
    notify_early: a.notify_early,
    created_at: a.created_at,
    reminder: summariseReminders(a.appointment_reminders ?? []),
  };
}

async function orgTimezone(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).single();
  return data?.timezone ?? "Asia/Dubai";
}

/** [from 00:00, to+1 00:00) of local dates in a timezone, as ISO instants. */
function dayRange(from: string, to: string, tz: string): { gte: string; lt: string } {
  return {
    gte: localMinutesToInstant(from, 0, tz).toISOString(),
    lt: localMinutesToInstant(to, 1440, tz).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Appointments + time blocks for one local day (resource view) or any range (calendar). */
export async function listRange(input: {
  from: string;
  to: string;
  locationId?: string | null;
  specialistId?: string | null;
  /** Use this location's clock for the day bounds without filtering by it. */
  tzLocationId?: string | null;
}): Promise<ActionResult<{ appointments: ApptRow[]; blocks: BlockRow[] }>> {
  const member = await requirePerm("appointments.view");
  const p = z
    .object({
      from: dateStr,
      to: dateStr,
      locationId: uuid.nullish(),
      specialistId: uuid.nullish(),
      tzLocationId: uuid.nullish(),
    })
    .safeParse(input);
  if (!p.success) return fail("Invalid range.");
  const admin = createAdminClient();
  let tz = await orgTimezone(admin, member.orgId);
  const tzLocation = p.data.tzLocationId ?? p.data.locationId;
  if (tzLocation) {
    const { data: loc } = await admin
      .from("locations")
      .select("timezone")
      .eq("id", tzLocation)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (loc) tz = loc.timezone;
  }
  const range = dayRange(p.data.from, p.data.to, tz);

  let aq = admin
    .from("appointments")
    .select(APPT_SELECT)
    .eq("org_id", member.orgId)
    .gte("starts_at", range.gte)
    .lt("starts_at", range.lt)
    .order("starts_at")
    .limit(2000);
  let bq = admin
    .from("time_blocks")
    .select("id, specialist_id, location_id, starts_at, ends_at, reason")
    .eq("org_id", member.orgId)
    .lt("starts_at", range.lt)
    .gt("ends_at", range.gte)
    .limit(1000);
  if (p.data.locationId) {
    aq = aq.eq("location_id", p.data.locationId);
    bq = bq.or(`location_id.is.null,location_id.eq.${p.data.locationId}`);
  }
  if (p.data.specialistId) {
    aq = aq.eq("specialist_id", p.data.specialistId);
    bq = bq.eq("specialist_id", p.data.specialistId);
  }
  const [{ data: appts, error }, { data: blocks }] = await Promise.all([aq, bq]);
  if (error) return fail("Could not load appointments.");
  return {
    ok: true,
    data: {
      appointments: ((appts ?? []) as unknown as JoinedAppointment[]).map(toRow),
      blocks: blocks ?? [],
    },
  };
}

const listSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  locationId: uuid.optional(),
  specialistId: uuid.optional(),
  serviceId: uuid.optional(),
  status: z.array(z.enum(APPOINTMENT_STATUSES)).max(5).optional(),
  source: z.enum(["portal", "unite", "bot"]).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z
    .object({
      field: z.enum(["starts_at", "number", "status", "created_at"]),
      dir: z.enum(["asc", "desc"]),
    })
    .optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(10).max(500).optional(),
});

/** Resolves the async parts of a filter (timezone, patient search) and returns a query factory. */
async function listBuilder(admin: AdminClient, orgId: string, q: z.infer<typeof listSchema>) {
  const tz = await orgTimezone(admin, orgId);
  const term = (q.q ?? "").replace(/[%_,()\\]/g, " ").trim();
  let ors: string[] | null = null;
  if (term) {
    const digits = term.replace(/\D/g, "");
    const { data: people } = await admin
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .or(
        [`full_name.ilike.%${term}%`, digits.length >= 3 ? `phone_e164.like.%${digits}%` : null]
          .filter(Boolean)
          .join(","),
      )
      .limit(200);
    ors = [`external_id.ilike.%${term}%`];
    if (/^\d+$/.test(term)) ors.push(`number.eq.${term}`);
    if (people?.length) ors.push(`contact_id.in.(${people.map((p) => p.id).join(",")})`);
  }
  return () => {
    let query = admin
      .from("appointments")
      .select(APPT_SELECT, { count: "exact" })
      .eq("org_id", orgId);
    if (q.from || q.to) {
      const range = dayRange(q.from ?? q.to!, q.to ?? q.from!, tz);
      if (q.from) query = query.gte("starts_at", range.gte);
      if (q.to) query = query.lt("starts_at", range.lt);
    }
    if (q.locationId) query = query.eq("location_id", q.locationId);
    if (q.specialistId) query = query.eq("specialist_id", q.specialistId);
    if (q.serviceId) query = query.eq("service_id", q.serviceId);
    if (q.status?.length) query = query.in("status", q.status);
    if (q.source) query = query.eq("source", q.source);
    if (ors) query = query.or(ors.join(","));
    const sort = q.sort ?? { field: "starts_at", dir: "desc" };
    return query.order(sort.field, { ascending: sort.dir === "asc" }).order("id");
  };
}

export async function listAppointments(
  input: ListQuery,
): Promise<ActionResult<{ rows: ApptRow[]; total: number }>> {
  const member = await requirePerm("appointments.view");
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid filters.");
  const admin = createAdminClient();
  const pageSize = parsed.data.pageSize ?? 100;
  const page = parsed.data.page ?? 1;
  const build = await listBuilder(admin, member.orgId, parsed.data);
  const { data, count, error } = await build().range((page - 1) * pageSize, page * pageSize - 1);
  if (error) return fail("Could not load appointments.");
  return {
    ok: true,
    data: { rows: ((data ?? []) as unknown as JoinedAppointment[]).map(toRow), total: count ?? 0 },
  };
}

/** CSV of the current filters (max 5,000 rows). Needs contacts.export — it contains patient names. */
export async function exportAppointments(
  input: ListQuery,
  scope: "filtered" | "all",
): Promise<ActionResult<{ csv: string; rows: number }>> {
  const member = await requirePerm("contacts.export");
  await requirePerm("appointments.view");
  const parsed = listSchema.safeParse(scope === "all" ? {} : input);
  if (!parsed.success) return fail("Invalid filters.");
  const admin = createAdminClient();
  const build = await listBuilder(admin, member.orgId, parsed.data);
  const [{ data, error }, { data: locs }, { data: specs }, { data: svcs }, tz] = await Promise.all([
    build().limit(5000),
    admin.from("locations").select("id, name").eq("org_id", member.orgId),
    admin.from("specialists").select("id, name").eq("org_id", member.orgId),
    admin.from("services").select("id, name").eq("org_id", member.orgId),
    orgTimezone(admin, member.orgId),
  ]);
  if (error) return fail("Could not export.");
  const name = (list: Array<{ id: string; name: string }> | null, id: string | null) =>
    list?.find((x) => x.id === id)?.name ?? "";
  const rows = ((data ?? []) as unknown as JoinedAppointment[]).map(toRow);
  const csv = toCsv(
    [
      "Number",
      "Patient",
      "Phone",
      "Status",
      "Starts",
      "Ends",
      "Location",
      "Specialist",
      "Service",
      "Source",
      "External ID",
      "Reminder",
      "Notes",
    ],
    rows.map((r) => [
      String(r.number),
      r.contact_name,
      r.phone ?? "",
      r.status,
      localDate(new Date(r.starts_at), tz) +
        " " +
        new Date(r.starts_at).toLocaleTimeString("en-GB", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
        }),
      new Date(r.ends_at).toLocaleTimeString("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
      }),
      name(locs, r.location_id),
      name(specs, r.specialist_id),
      name(svcs, r.service_id),
      r.source,
      r.external_id ?? "",
      r.reminder ?? "",
      r.notes ?? "",
    ]),
  );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.exported",
    entity: "appointments",
    diff: { rows: rows.length, scope },
  });
  return { ok: true, data: { csv, rows: rows.length } };
}

export async function getFreeSlots(input: {
  specialistId: string;
  locationId: string;
  serviceId: string;
  date: string;
  excludeAppointmentId?: string;
}): Promise<ActionResult<{ slots: SlotOption[] }>> {
  const member = await requirePerm("appointments.view");
  const p = z
    .object({
      specialistId: uuid,
      locationId: uuid,
      serviceId: uuid,
      date: dateStr,
      excludeAppointmentId: uuid.optional(),
    })
    .safeParse(input);
  if (!p.success) return fail("Choose a location, specialist, service and date.");
  const admin = createAdminClient();
  const { data: service } = await admin
    .from("services")
    .select("duration_min")
    .eq("id", p.data.serviceId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!service) return fail("Service not found.");
  const slots = await slotsForDay(admin, {
    orgId: member.orgId,
    specialistId: p.data.specialistId,
    locationId: p.data.locationId,
    date: p.data.date,
    durationMin: service.duration_min,
    excludeAppointmentId: p.data.excludeAppointmentId,
    ignoreLeadTime: true,
  });
  return {
    ok: true,
    data: { slots: slots.map((s) => ({ start: s.start.toISOString(), label: s.label })) },
  };
}

export async function getAppointmentDetail(id: string): Promise<ActionResult<ApptDetail>> {
  const member = await requirePerm("appointments.view");
  if (!uuid.safeParse(id).success) return fail("Invalid appointment.");
  const admin = createAdminClient();
  const { data: a } = await admin
    .from("appointments")
    .select(APPT_SELECT)
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!a) return fail("Appointment not found.");
  const [{ data: reminders }, { data: history }] = await Promise.all([
    admin
      .from("appointment_reminders")
      .select("idx, status, due_at, sent_at, exclusion_reason, error")
      .eq("appointment_id", id)
      .order("idx"),
    a.contact_id
      ? admin
          .from("timeline_events")
          .select("id, type, at, payload")
          .eq("org_id", member.orgId)
          .eq("contact_id", a.contact_id)
          .like("type", "appointment.%")
          .order("at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),
  ]);
  return {
    ok: true,
    data: {
      appointment: toRow(a as unknown as JoinedAppointment),
      reminders: reminders ?? [],
      history: (history ?? [])
        .filter((h) => (h.payload as Record<string, unknown>)?.appointment_id === id)
        .map((h) => ({
          id: h.id,
          type: h.type,
          at: h.at,
          payload: h.payload as Record<string, unknown>,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// Writes (appointments.manage)
// ---------------------------------------------------------------------------

const bookSchema = z.object({
  contactId: uuid,
  locationId: uuid,
  specialistId: uuid,
  serviceId: uuid,
  startsAt: z.string().datetime(),
  notes: z.string().trim().max(2000).nullish(),
  notifyEarly: z.boolean().default(false),
  notify: z.boolean().default(false),
  override: z.boolean().default(false),
});

export async function bookAppointment(
  input: z.input<typeof bookSchema>,
): Promise<ActionResult<{ id: string; number: number; notified: boolean; notifyError?: string }>> {
  const member = await requirePerm("appointments.manage");
  const p = bookSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the appointment details.");
  const admin = createAdminClient();
  const res = await createAppointment(admin, {
    orgId: member.orgId,
    actorId: member.userId,
    contactId: p.data.contactId,
    locationId: p.data.locationId,
    specialistId: p.data.specialistId,
    serviceId: p.data.serviceId,
    startsAt: new Date(p.data.startsAt),
    notes: p.data.notes,
    notifyEarly: p.data.notifyEarly,
    notify: p.data.notify,
    override: p.data.override,
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointment.created",
    entity: "appointment",
    entityId: res.appointment.id,
    diff: { number: res.appointment.number, override: p.data.override },
  });
  refresh();
  const note = res.notification;
  return {
    ok: true,
    data: {
      id: res.appointment.id,
      number: res.appointment.number,
      notified: !!note?.ok,
      notifyError: note && !note.ok ? note.error : undefined,
    },
    message: `Appointment #${res.appointment.number} booked.`,
  };
}

const blockSchema = z.object({
  specialistId: uuid,
  locationId: uuid.nullish(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().trim().max(200).nullish(),
});

export async function blockTime(input: z.input<typeof blockSchema>): Promise<ActionResult> {
  const member = await requirePerm("appointments.manage");
  const p = blockSchema.safeParse(input);
  if (!p.success) return fail("Check the block details.");
  const res = await createTimeBlock(createAdminClient(), {
    orgId: member.orgId,
    actorId: member.userId,
    specialistId: p.data.specialistId,
    locationId: p.data.locationId,
    startsAt: new Date(p.data.startsAt),
    endsAt: new Date(p.data.endsAt),
    reason: p.data.reason,
  });
  if (!res.ok) return fail(res.error);
  refresh();
  return { ok: true, message: "Time blocked." };
}

export async function deleteBlock(id: string): Promise<ActionResult> {
  const member = await requirePerm("appointments.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid block.");
  const admin = createAdminClient();
  await admin.from("time_blocks").delete().eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.block_removed",
    entity: "time_block",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Block removed." };
}

export async function setStatus(input: {
  id: string;
  to: string;
  notify?: boolean;
}): Promise<ActionResult<{ notified: boolean; notifyError?: string }>> {
  const member = await requirePerm("appointments.manage");
  if (!uuid.safeParse(input.id).success || !isAppointmentStatus(input.to))
    return fail("Invalid status change.");
  const admin = createAdminClient();
  const res = await changeAppointmentStatus(admin, {
    orgId: member.orgId,
    appointmentId: input.id,
    to: input.to,
    actorId: member.userId,
    notify: !!input.notify,
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointment.status_changed",
    entity: "appointment",
    entityId: input.id,
    diff: { to: input.to },
  });
  refresh();
  const n = res.notification;
  return {
    ok: true,
    data: { notified: !!n?.ok, notifyError: n && !n.ok ? n.error : undefined },
    message: `Marked ${input.to.replace("_", "-")}.`,
  };
}

const moveSchema = z.object({
  id: uuid,
  startsAt: z.string().datetime(),
  specialistId: uuid.optional(),
  locationId: uuid.optional(),
  override: z.boolean().default(false),
  notify: z.boolean().default(false),
});

export async function moveAppointment(
  input: z.input<typeof moveSchema>,
): Promise<ActionResult<{ notified: boolean; notifyError?: string }>> {
  const member = await requirePerm("appointments.manage");
  const p = moveSchema.safeParse(input);
  if (!p.success) return fail("Check the new time.");
  const admin = createAdminClient();
  const res = await rescheduleAppointment(admin, {
    orgId: member.orgId,
    appointmentId: p.data.id,
    actorId: member.userId,
    startsAt: new Date(p.data.startsAt),
    specialistId: p.data.specialistId,
    locationId: p.data.locationId,
    override: p.data.override,
    notify: p.data.notify,
  });
  if (!res.ok) return fail(res.error);
  refresh();
  const n = res.notification;
  return {
    ok: true,
    data: { notified: !!n?.ok, notifyError: n && !n.ok ? n.error : undefined },
    message: "Appointment rescheduled.",
  };
}

export async function updateAppointmentNotes(input: {
  id: string;
  notes: string;
  notifyEarly: boolean;
}): Promise<ActionResult> {
  const member = await requirePerm("appointments.manage");
  const p = z
    .object({ id: uuid, notes: z.string().trim().max(2000), notifyEarly: z.boolean() })
    .safeParse(input);
  if (!p.success) return fail("Invalid notes.");
  const admin = createAdminClient();
  const { error } = await admin
    .from("appointments")
    .update({ notes: p.data.notes || null, notify_early: p.data.notifyEarly })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save.");
  // The notes themselves are health data: the audit entry records only that they changed.
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointment.notes_updated",
    entity: "appointment",
    entityId: p.data.id,
  });
  refresh();
  return { ok: true, message: "Saved." };
}

/** Re-send the reminder template for one appointment right now (reception "nudge"). */
export async function sendReminderNow(id: string): Promise<ActionResult> {
  const member = await requirePerm("appointments.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid appointment.");
  const res = await sendAppointmentTemplate(createAdminClient(), {
    orgId: member.orgId,
    appointmentId: id,
    key: "reminder",
    sentByUserId: member.userId,
  });
  if (!res.ok) return fail(res.error);
  refresh();
  return { ok: true, message: "Reminder queued." };
}

/** Appointments of one patient (contact drawer → Appointments tab). */
export async function listContactAppointments(
  contactId: string,
): Promise<ActionResult<{ rows: ApptRow[]; timezone: string; canBook: boolean }>> {
  const member = await requirePerm("appointments.view");
  if (!uuid.safeParse(contactId).success) return fail("Invalid patient.");
  const admin = createAdminClient();
  const [{ data, error }, timezone] = await Promise.all([
    admin
      .from("appointments")
      .select(APPT_SELECT)
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("starts_at", { ascending: false })
      .limit(50),
    orgTimezone(admin, member.orgId),
  ]);
  if (error) return fail("Could not load appointments.");
  return {
    ok: true,
    data: {
      rows: ((data ?? []) as unknown as JoinedAppointment[]).map(toRow),
      timezone,
      canBook: can(member, "appointments.manage"),
    },
  };
}
