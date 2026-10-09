"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { appointmentSettingsSchema, writeAppointmentSettings } from "@/lib/appointments/settings";
import { syncAppointmentReminders } from "@/lib/appointments/service";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

function refresh() {
  revalidatePath("/settings/appointments");
  revalidatePath("/appointments");
}

function fail(error: { code?: string; message: string }, dup: string): ActionResult {
  return { ok: false, error: error.code === "23505" ? dup : "Could not save. Please try again." };
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// --- Locations -------------------------------------------------------------

const locationSchema = z.object({
  id: uuid.nullish(),
  name: z.string().trim().min(1, "Enter a name").max(80),
  timezone: z.string().refine(isTimezone, "Unknown timezone"),
  address: optionalText(300),
  external_id: optionalText(60),
  active: z.boolean().default(true),
});

export async function saveLocation(input: z.input<typeof locationSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = locationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { id, ...row } = parsed.data;
  const admin = createAdminClient();
  const q = id
    ? admin.from("locations").update(row).eq("id", id).eq("org_id", member.orgId)
    : admin.from("locations").insert({ ...row, org_id: member.orgId });
  const { error } = await q;
  if (error) return fail(error, "A location with that name or Unite clinic id already exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "appointments.location_updated" : "appointments.location_created",
    entity: "location",
    entityId: id ?? undefined,
    diff: { name: row.name } as Json,
  });
  refresh();
  return { ok: true, message: "Location saved." };
}

export async function deleteLocation(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid location." };
  const admin = createAdminClient();
  const { error } = await admin.from("locations").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the location." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.location_deleted",
    entity: "location",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Location deleted." };
}

// --- Departments -----------------------------------------------------------

const departmentSchema = z.object({
  id: uuid.nullish(),
  name: z.string().trim().min(1, "Enter a name").max(80),
  active: z.boolean().default(true),
});

export async function saveDepartment(
  input: z.input<typeof departmentSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = departmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { id, ...row } = parsed.data;
  const admin = createAdminClient();
  const { error } = await (id
    ? admin.from("departments").update(row).eq("id", id).eq("org_id", member.orgId)
    : admin.from("departments").insert({ ...row, org_id: member.orgId }));
  if (error) return fail(error, "A department with that name already exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.department_saved",
    entity: "department",
    entityId: id ?? undefined,
    diff: { name: row.name } as Json,
  });
  refresh();
  return { ok: true, message: "Department saved." };
}

export async function deleteDepartment(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid department." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("departments")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the department." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.department_deleted",
    entity: "department",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Department deleted." };
}

// --- Services --------------------------------------------------------------

const serviceSchema = z.object({
  id: uuid.nullish(),
  name: z.string().trim().min(1, "Enter a name").max(120),
  department_id: uuid.nullish(),
  duration_min: z.number().int().min(5).max(480),
  price: z.number().min(0).max(1_000_000).nullish(),
  active: z.boolean().default(true),
});

export async function saveService(input: z.input<typeof serviceSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = serviceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { id, ...row } = parsed.data;
  const admin = createAdminClient();
  if (row.department_id) {
    const { data } = await admin
      .from("departments")
      .select("id")
      .eq("id", row.department_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return { ok: false, error: "That department does not exist." };
  }
  const values = { ...row, department_id: row.department_id ?? null, price: row.price ?? null };
  const { error } = await (id
    ? admin.from("services").update(values).eq("id", id).eq("org_id", member.orgId)
    : admin.from("services").insert({ ...values, org_id: member.orgId }));
  if (error) return fail(error, "A service with that name already exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.service_saved",
    entity: "service",
    entityId: id ?? undefined,
    diff: { name: row.name } as Json,
  });
  refresh();
  return { ok: true, message: "Service saved." };
}

export async function deleteService(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid service." };
  const admin = createAdminClient();
  const { error } = await admin.from("services").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the service." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.service_deleted",
    entity: "service",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Service deleted." };
}

// --- Specialists -----------------------------------------------------------

const hoursRow = z
  .object({
    location_id: uuid,
    weekday: z.number().int().min(1).max(7),
    start_min: z.number().int().min(0).max(1439),
    end_min: z.number().int().min(1).max(1440),
  })
  .refine((h) => h.end_min > h.start_min, "Working hours must end after they start");

const specialistSchema = z.object({
  id: uuid.nullish(),
  name: z.string().trim().min(1, "Enter a name").max(120),
  title: optionalText(120),
  department_id: uuid.nullish(),
  external_id: optionalText(60),
  user_id: uuid.nullish(),
  active: z.boolean().default(true),
  location_ids: z.array(uuid).max(50),
  service_ids: z.array(uuid).max(200),
  working_hours: z.array(hoursRow).max(300),
});

export async function saveSpecialist(
  input: z.input<typeof specialistSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = specialistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const { id, location_ids, service_ids, working_hours, ...row } = parsed.data;
  const admin = createAdminClient();

  // Everything referenced must belong to this org.
  const [locs, svcs, dept, usr] = await Promise.all([
    location_ids.length
      ? admin.from("locations").select("id").eq("org_id", member.orgId).in("id", location_ids)
      : Promise.resolve({ data: [] as Array<{ id: string }> }),
    service_ids.length
      ? admin.from("services").select("id").eq("org_id", member.orgId).in("id", service_ids)
      : Promise.resolve({ data: [] as Array<{ id: string }> }),
    row.department_id
      ? admin
          .from("departments")
          .select("id")
          .eq("id", row.department_id)
          .eq("org_id", member.orgId)
          .maybeSingle()
      : Promise.resolve({ data: { id: "" } }),
    row.user_id
      ? admin
          .from("memberships")
          .select("user_id")
          .eq("user_id", row.user_id)
          .eq("org_id", member.orgId)
          .maybeSingle()
      : Promise.resolve({ data: { user_id: "" } }),
  ]);
  if ((locs.data?.length ?? 0) !== new Set(location_ids).size)
    return { ok: false, error: "A selected location does not exist." };
  if ((svcs.data?.length ?? 0) !== new Set(service_ids).size)
    return { ok: false, error: "A selected service does not exist." };
  if (!dept.data) return { ok: false, error: "That department does not exist." };
  if (!usr.data) return { ok: false, error: "That user is not in this workspace." };
  const allowedLocations = new Set(location_ids);
  if (working_hours.some((h) => !allowedLocations.has(h.location_id)))
    return { ok: false, error: "Working hours can only be set for the specialist's locations." };

  const values = {
    name: row.name,
    title: row.title,
    department_id: row.department_id ?? null,
    external_id: row.external_id,
    user_id: row.user_id ?? null,
    active: row.active,
  };
  let specialistId = id ?? null;
  if (specialistId) {
    const { error } = await admin
      .from("specialists")
      .update(values)
      .eq("id", specialistId)
      .eq("org_id", member.orgId);
    if (error) return fail(error, "Another specialist already has that Unite doctor id.");
  } else {
    const { data, error } = await admin
      .from("specialists")
      .insert({ ...values, org_id: member.orgId })
      .select("id")
      .single();
    if (error) return fail(error, "Another specialist already has that Unite doctor id.");
    specialistId = data.id;
  }

  // Replace links and weekly hours wholesale.
  await Promise.all([
    admin.from("specialist_locations").delete().eq("specialist_id", specialistId),
    admin.from("specialist_services").delete().eq("specialist_id", specialistId),
    admin.from("working_hours").delete().eq("specialist_id", specialistId),
  ]);
  if (location_ids.length)
    await admin.from("specialist_locations").insert(
      [...new Set(location_ids)].map((location_id) => ({
        org_id: member.orgId,
        specialist_id: specialistId,
        location_id,
      })),
    );
  if (service_ids.length)
    await admin.from("specialist_services").insert(
      [...new Set(service_ids)].map((service_id) => ({
        org_id: member.orgId,
        specialist_id: specialistId,
        service_id,
      })),
    );
  if (working_hours.length)
    await admin
      .from("working_hours")
      .insert(
        working_hours.map((h) => ({ ...h, org_id: member.orgId, specialist_id: specialistId })),
      );

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "appointments.specialist_updated" : "appointments.specialist_created",
    entity: "specialist",
    entityId: specialistId,
    diff: { name: row.name, locations: location_ids.length, services: service_ids.length } as Json,
  });
  refresh();
  return { ok: true, message: "Specialist saved." };
}

export async function deleteSpecialist(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid specialist." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("specialists")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the specialist." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.specialist_deleted",
    entity: "specialist",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Specialist deleted." };
}

// --- Booking rules & template mapping ---------------------------------------

export async function saveBookingRules(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = appointmentSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const s = parsed.data;
  const admin = createAdminClient();

  const templateIds = Object.values(s.templates).filter((t): t is string => !!t);
  if (templateIds.length) {
    const { data } = await admin
      .from("wa_templates")
      .select("id")
      .eq("org_id", member.orgId)
      .in("id", templateIds);
    if ((data?.length ?? 0) !== new Set(templateIds).size)
      return { ok: false, error: "A mapped template does not exist." };
  }
  if (s.channel_id) {
    const { data } = await admin
      .from("channels")
      .select("id")
      .eq("id", s.channel_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return { ok: false, error: "That WhatsApp number does not exist." };
  }

  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const next = writeAppointmentSettings(org?.settings, s);
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the booking rules." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.rules_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { ...s, reminder_test_numbers: s.reminder_test_numbers.length } as Json,
  });

  // Re-plan reminders of upcoming appointments now (the 5-minute sweep would also catch it).
  const { data: upcoming } = await admin
    .from("appointments")
    .select("id, org_id, contact_id, starts_at, status")
    .eq("org_id", member.orgId)
    .in("status", ["awaiting", "confirmed"])
    .gt("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(500);
  for (const a of upcoming ?? []) await syncAppointmentReminders(admin, a, { settings: s });

  refresh();
  return { ok: true, message: "Booking rules saved." };
}

// --- Reminder exclusions ------------------------------------------------------

const exclusionSchema = z.object({
  kind: z.enum(["placeholder_name", "doctor"]),
  match_type: z.enum(["equals", "contains"]),
  value: z.string().trim().min(1, "Enter a value").max(120),
  reason: optionalText(200),
});

export async function addExclusion(input: z.input<typeof exclusionSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = exclusionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const admin = createAdminClient();
  const { error } = await admin
    .from("reminder_exclusions")
    .insert({ ...parsed.data, org_id: member.orgId });
  if (error) return fail(error, "That exclusion already exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.reminder_exclusion_added",
    entity: "reminder_exclusion",
    entityId: undefined,
  });
  refresh();
  return { ok: true, message: "Exclusion added." };
}

export async function removeExclusion(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid exclusion." };
  const admin = createAdminClient();
  await admin.from("reminder_exclusions").delete().eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.reminder_exclusion_removed",
    entity: "reminder_exclusion",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Exclusion removed." };
}

export async function loadDefaultExclusions(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { error } = await admin.rpc("seed_reminder_exclusions", { p_org: member.orgId });
  if (error) return { ok: false, error: "Could not load the defaults." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "appointments.reminder_exclusions_defaults_loaded",
    entity: "reminder_exclusion",
    entityId: undefined,
  });
  refresh();
  return { ok: true, message: "Defaults from the previous Make scenarios loaded." };
}
