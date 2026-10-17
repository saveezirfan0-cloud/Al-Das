"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { slotsForDay } from "@/lib/appointments/availability";
import { loadCapacityConflicts } from "@/lib/appointments/conflicts";
import {
  changeAppointmentStatus,
  createAppointment,
  createTimeBlock,
  rescheduleAppointment,
  sendAppointmentTemplate,
} from "@/lib/appointments/service";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import { APPOINTMENT_STATUSES, isAppointmentStatus } from "@/lib/appointments/status";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { accessFilterIds, withBranchFilter } from "@/lib/branches/filter";
import {
  BRANCH_DENIED,
  branchAllowed,
  memberBranchView,
  rowOutsideBranches,
} from "@/lib/branches/guard";
import { toCsv } from "@/lib/csv";
import {
  ensureRoom,
  revokeRoomsSafely,
  ROOM_FAILURE_TEXT,
} from "@/lib/integrations/telehealth/server";
import { formatPhone } from "@/lib/phone";
import { recordAccess, recordExport } from "@/lib/security/access-log";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
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
    visit_mode: a.visit_mode,
    checkin_status: a.checkin_status ?? null,
  };
}

async function orgTimezone(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).single();
  return data?.timezone ?? "Asia/Dubai";
}

/**
 * Phase 20c: marks rows that break the capacity rules today (blocks, buffers, places), e.g. a Unite
 * appointment booked in Unite over a lunch block. Read-only and display only (lib/appointments/conflicts.ts).
 */
async function withConflicts(
  admin: AdminClient,
  orgId: string,
  rows: ApptRow[],
): Promise<ApptRow[]> {
  const ids = rows
    .filter((r) => r.specialist_id && (r.status === "awaiting" || r.status === "confirmed"))
    .map((r) => r.id);
  if (ids.length === 0) return rows;
  const byId = await loadCapacityConflicts(admin, orgId, ids);
  return rows.map((r) => ({ ...r, conflict: byId.get(r.id) ?? null }));
}

/** [from 00:00, to+1 00:00) of local dates in a timezone, as ISO instants. */
function dayRange(from: string, to: string, tz: string): { gte: string; lt: string } {
  return {
    gte: localMinutesToInstant(from, 0, tz).toISOString(),
    lt: localMinutesToInstant(to, 1440, tz).toISOString(),
  };
}

/**
 * Phase B: the branch filter for a list read. A branch named by the screen must be one the member may work in
 * (`denied`); with none named, the member's branch view (switcher choice, else every branch they may see).
 */
async function listBranchFilter(
  admin: AdminClient,
  member: CurrentMember,
  locationId: string | null | undefined,
): Promise<{ denied: boolean; filterIds: string[] | null }> {
  if (locationId) return { denied: !branchAllowed(member, locationId), filterIds: null };
  return { denied: false, filterIds: (await memberBranchView(admin, member)).filterIds };
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
  const admin = createAdminClient(member.userId);
  const branch = await listBranchFilter(admin, member, p.data.locationId);
  if (branch.denied) return fail(BRANCH_DENIED);
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

  // Up to 2,000 appointments, read in pages (PostgREST returns at most 1,000 per request).
  const aq = fetchAll(
    (from, to) => {
      let q = admin
        .from("appointments")
        .select(APPT_SELECT)
        .eq("org_id", member.orgId)
        .gte("starts_at", range.gte)
        .lt("starts_at", range.lt);
      if (p.data.locationId) q = q.eq("location_id", p.data.locationId);
      if (p.data.specialistId) q = q.eq("specialist_id", p.data.specialistId);
      q = withBranchFilter(q, branch.filterIds);
      return q.order("starts_at").order("id").range(from, to);
    },
    { max: 2000 },
  );
  let bq = admin
    .from("time_blocks")
    .select("id, specialist_id, location_id, starts_at, ends_at, reason")
    .eq("org_id", member.orgId)
    .lt("starts_at", range.lt)
    .gt("ends_at", range.gte)
    .limit(1000);
  if (p.data.locationId) {
    bq = bq.or(`location_id.is.null,location_id.eq.${p.data.locationId}`);
  }
  if (p.data.specialistId) {
    bq = bq.eq("specialist_id", p.data.specialistId);
  }
  bq = withBranchFilter(bq, branch.filterIds);
  const [{ data: appts, error }, { data: blocks }] = await Promise.all([aq, bq]);
  if (error) return fail("Could not load appointments.");
  return {
    ok: true,
    data: {
      appointments: await withConflicts(
        admin,
        member.orgId,
        ((appts ?? []) as unknown as JoinedAppointment[]).map(toRow),
      ),
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
  source: z.enum(["portal", "unite", "bot", "import"]).optional(),
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
async function listBuilder(
  admin: AdminClient,
  orgId: string,
  q: z.infer<typeof listSchema>,
  /** Phase B: the member's branch filter (null = none). */
  branchIds: readonly string[] | null = null,
) {
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
    query = withBranchFilter(query, branchIds);
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
  const admin = createAdminClient(member.userId);
  const pageSize = parsed.data.pageSize ?? 100;
  const page = parsed.data.page ?? 1;
  const branch = await listBranchFilter(admin, member, parsed.data.locationId);
  if (branch.denied) return fail(BRANCH_DENIED);
  const build = await listBuilder(admin, member.orgId, parsed.data, branch.filterIds);
  const { data, count, error } = await build().range((page - 1) * pageSize, page * pageSize - 1);
  if (error) return fail("Could not load appointments.");
  await recordAccess(admin, member, {
    entity: "appointment",
    action: "list",
    detail: { rows: data?.length ?? 0 },
  });
  return {
    ok: true,
    data: {
      rows: await withConflicts(
        admin,
        member.orgId,
        ((data ?? []) as unknown as JoinedAppointment[]).map(toRow),
      ),
      total: count ?? 0,
    },
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
  const admin = createAdminClient(member.userId);
  const branch = await listBranchFilter(admin, member, parsed.data.locationId);
  if (branch.denied) return fail(BRANCH_DENIED);
  const build = await listBuilder(admin, member.orgId, parsed.data, branch.filterIds);
  const [{ data, error }, { data: locs }, { data: specs }, { data: svcs }, tz] = await Promise.all([
    // Every row up to 5,000, in pages (PostgREST returns at most 1,000 per request); build() orders by id last.
    fetchAll((from, to) => build().range(from, to), { max: 5000 }),
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
  await recordExport(admin, member, { dataset: "appointments", rows: rows.length });
  return { ok: true, data: { csv, rows: rows.length } };
}

export async function getFreeSlots(input: {
  specialistId: string;
  locationId: string;
  serviceId: string;
  date: string;
  excludeAppointmentId?: string;
  /** The booking drawer asks for taken slots too; they are returned only when the org's ShowBusy setting is on. */
  includeTaken?: boolean;
}): Promise<ActionResult<{ slots: SlotOption[] }>> {
  const member = await requirePerm("appointments.view");
  const p = z
    .object({
      specialistId: uuid,
      locationId: uuid,
      serviceId: uuid,
      date: dateStr,
      excludeAppointmentId: uuid.optional(),
      includeTaken: z.boolean().optional(),
    })
    .safeParse(input);
  if (!p.success) return fail("Choose a location, specialist, service and date.");
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  const { data: service } = await admin
    .from("services")
    .select("duration_min")
    .eq("id", p.data.serviceId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!service) return fail("Service not found.");
  const slots = await slotsForDay(
    admin,
    {
      orgId: member.orgId,
      specialistId: p.data.specialistId,
      locationId: p.data.locationId,
      date: p.data.date,
      durationMin: service.duration_min,
      serviceId: p.data.serviceId,
      excludeAppointmentId: p.data.excludeAppointmentId,
      ignoreLeadTime: true,
    },
    {
      includeTaken: !!p.data.includeTaken && readAppointmentSettings(member.org.settings).show_busy,
    },
  );
  return {
    ok: true,
    data: {
      slots: slots.map((s) => ({
        start: s.start.toISOString(),
        label: s.label,
        ...(s.taken ? { taken: s.taken } : {}),
      })),
    },
  };
}

export type ApptInvoice = {
  id: string;
  number: string | null;
  date: string | null;
  net: number | null;
  paid: number | null;
};

/**
 * Unite invoices linked to this appointment (amounts and dates only). Empty, with no hint, for a member without
 * finance.invoices.view. Read with the member's own client, so RLS (finance key, branch rule) decides.
 */
export async function getAppointmentInvoices(id: string): Promise<ActionResult<ApptInvoice[]>> {
  const member = await requirePerm("appointments.view");
  if (!uuid.safeParse(id).success) return fail("Invalid appointment.");
  if (!can(member, "finance.invoices.view")) return { ok: true, data: [] };
  const supabase = await createClient();
  const { data: appt } = await supabase
    .from("appointments")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!appt) return { ok: true, data: [] };
  const { data: links, error } = await supabase
    .from("v_fin_invoice_links")
    .select("invoice_id")
    .eq("org_id", member.orgId)
    .eq("appointment_row_id", id)
    .limit(20);
  if (error) return fail("Could not load the invoices.");
  const ids = (links ?? []).map((l) => l.invoice_id).filter((x): x is string => !!x);
  if (ids.length === 0) return { ok: true, data: [] };
  const { data, error: listError } = await supabase
    .from("v_fin_invoice_list")
    .select("id, inv_display_number, transaction_date, net, paid")
    .eq("org_id", member.orgId)
    .in("id", ids)
    .order("transaction_date", { ascending: false });
  if (listError) return fail("Could not load the invoices.");
  await recordAccess(createAdminClient(), member, {
    entity: "finance_invoice",
    action: "list",
    detail: { rows: (data ?? []).length, source: "appointment" },
  });
  return {
    ok: true,
    data: (data ?? [])
      .filter((r): r is typeof r & { id: string } => !!r.id)
      .map((r) => ({
        id: r.id,
        number: r.inv_display_number,
        date: r.transaction_date,
        net: r.net === null ? null : Number(r.net),
        paid: r.paid === null ? null : Number(r.paid),
      })),
  };
}

export async function getAppointmentDetail(id: string): Promise<ActionResult<ApptDetail>> {
  const member = await requirePerm("appointments.view");
  if (!uuid.safeParse(id).success) return fail("Invalid appointment.");
  const admin = createAdminClient(member.userId);
  const { data: a } = await admin
    .from("appointments")
    .select(APPT_SELECT)
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!a || !branchAllowed(member, a.location_id)) return fail("Appointment not found.");
  await recordAccess(admin, member, { entity: "appointment", entityId: id, action: "view" });
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
      appointment: (
        await withConflicts(admin, member.orgId, [toRow(a as unknown as JoinedAppointment)])
      )[0],
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
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
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
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const res = await createTimeBlock(createAdminClient(member.userId), {
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
  const admin = createAdminClient(member.userId);
  // Phase B: a block in a branch this member does not work in is refused, like its appointments.
  if (await rowOutsideBranches(admin, member, "time_blocks", id)) return fail(BRANCH_DENIED);
  const { data: removed, error } = await admin
    .from("time_blocks")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id");
  // A busy time mirrored from Google Calendar (Phase 20e) is removed only by the sync.
  if (error || !removed?.length)
    return fail(
      "This block cannot be removed here (busy times from Google Calendar follow the calendar).",
    );
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
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "appointments", input.id)) return fail(BRANCH_DENIED);
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
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "appointments", p.data.id))
    return fail(BRANCH_DENIED);
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
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointment.rescheduled",
    entity: "appointment",
    entityId: p.data.id,
    diff: { notify: p.data.notify, override: p.data.override },
  });
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
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "appointments", p.data.id))
    return fail(BRANCH_DENIED);
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
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "appointments", id)) return fail(BRANCH_DENIED);
  const res = await sendAppointmentTemplate(admin, {
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
  const admin = createAdminClient(member.userId);
  const [{ data, error }, timezone] = await Promise.all([
    withBranchFilter(
      admin
        .from("appointments")
        .select(APPT_SELECT)
        .eq("org_id", member.orgId)
        .eq("contact_id", contactId),
      accessFilterIds(readBranchAccess(member)),
    )
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

// ---------------------------------------------------------------------------
// Video visits (Phase 19b)
// ---------------------------------------------------------------------------

const visitModeSchema = z.object({ id: uuid, mode: z.enum(["in_person", "video"]).nullable() });

/** Sets whether this booking is a video visit (null = follow the service). Pulse-only: the Unite sync never writes it. */
export async function setVisitMode(input: z.input<typeof visitModeSchema>): Promise<ActionResult> {
  const member = await requirePerm("appointments.manage");
  const p = visitModeSchema.safeParse(input);
  if (!p.success) return fail("Invalid request.");
  const admin = createAdminClient(member.userId);
  const { data: before } = await admin
    .from("appointments")
    .select("id, visit_mode, location_id")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!before) return fail("Appointment not found.");
  if (!canSeeLocation(readBranchAccess(member), before.location_id)) return fail(BRANCH_DENIED);
  if ((before.visit_mode ?? null) === p.data.mode) return { ok: true };
  const { error } = await admin
    .from("appointments")
    .update({ visit_mode: p.data.mode })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the visit type.");
  // Not a video visit any more: the room stops working.
  if (p.data.mode === "in_person")
    await revokeRoomsSafely(admin, {
      orgId: member.orgId,
      appointmentId: p.data.id,
      reason: "in_person",
    });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointment.visit_mode_changed",
    entity: "appointment",
    entityId: p.data.id,
    diff: { to: p.data.mode },
  });
  refresh();
  return { ok: true, message: "Visit type saved." };
}

const joinSchema = z.object({ id: uuid, renew: z.boolean().default(false) });

/**
 * The video address for staff to join (or copy). Creates the room the first time. `renew` replaces the room with a new one (the old
 * address stops working) and needs the manage permission. No patient detail goes to the video provider.
 */
export async function getVideoJoinLink(
  input: z.input<typeof joinSchema>,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  const member = await requirePerm("appointments.view");
  const p = joinSchema.safeParse(input);
  if (!p.success) return fail("Invalid request.");
  if (p.data.renew && !can(member, "appointments.manage"))
    return fail("You do not have permission to make a new link.");
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "appointments", p.data.id))
    return fail("Appointment not found.");
  const r = await ensureRoom(admin, {
    orgId: member.orgId,
    appointmentId: p.data.id,
    actorId: member.userId,
    forceNew: p.data.renew,
  });
  if (!r.ok) return fail(ROOM_FAILURE_TEXT[r.reason]);
  await recordAccess(admin, member, {
    entity: "appointment",
    entityId: p.data.id,
    action: "view",
    detail: { video_link: true },
  });
  if (r.created)
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: p.data.renew ? "appointment.video_room_renewed" : "appointment.video_room_created",
      entity: "appointment",
      entityId: p.data.id,
    });
  return { ok: true, data: { url: r.url, expiresAt: r.expiresAt } };
}
