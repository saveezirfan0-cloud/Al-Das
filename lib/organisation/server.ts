import "server-only";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { localDate, shiftLocalDate } from "@/lib/appointments/slots";
import {
  allowedLocations,
  branchFilterIds,
  branchOrFilter,
  canSeeLocation,
  type BranchAccess,
} from "@/lib/branches/access";
import { hoursSummary, patientShortName } from "@/lib/organisation/doctors";
import {
  isRotaRole,
  ROTA_ROLE_LABELS,
  shiftLabel,
  weekStart,
  weekWindow,
} from "@/lib/organisation/rota";
import {
  EMPLOYMENT_TYPES,
  type DutyFrequency,
  type EmploymentType,
} from "@/lib/organisation/staff";
import type {
  BranchOption,
  DoctorDetail,
  DoctorRow,
  DutyRow,
  Option,
  ShiftRow,
  StaffRow,
} from "@/lib/organisation/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Service-role loaders for the Organisation pages (Phase C). Every caller has already checked the page permission;
 * these loaders follow the branch rule (app.location_visible_to) through lib/branches/access.ts: a doctor is listed
 * when they work in a branch the person may see (or in none), a staff member when their home branch is visible (or
 * unset), a shift when its branch is visible. Ids, names and dates only: no pay, no patient data.
 */

const personLabel = (
  p: { first_name?: string | null; last_name?: string | null; email?: string | null } | null,
) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || p.email || null : null);

/** The org's active branches the person may see, by name. */
export async function loadBranches(
  admin: AdminClient,
  orgId: string,
  access: BranchAccess,
): Promise<{ all: BranchOption[]; allowed: BranchOption[] }> {
  const { data } = await admin
    .from("locations")
    .select("id, name, timezone")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("name");
  const all = (data ?? []).map((l) => ({ id: l.id, name: l.name, timezone: l.timezone }));
  return { all, allowed: allowedLocations(all, access) };
}

export async function loadDepartments(admin: AdminClient, orgId: string): Promise<Option[]> {
  const { data } = await admin
    .from("departments")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("name");
  return (data ?? []).map((d) => ({ value: d.id, label: d.name }));
}

/** Members of the org (for the "linked Pulse user" pickers). */
export async function loadMemberOptions(admin: AdminClient, orgId: string): Promise<Option[]> {
  const { data } = await admin
    .from("memberships")
    .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (data ?? [])
    .map((m) => ({ value: m.user_id, label: personLabel(m.profiles) ?? m.user_id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** UTC bounds of today in the org's timezone. */
export function todayWindow(
  timezone: string,
  now: Date = new Date(),
): { today: string; from: string; to: string } {
  const today = localDate(now, timezone);
  return {
    today,
    from: fromZonedTime(`${today}T00:00:00`, timezone).toISOString(),
    to: fromZonedTime(`${shiftLocalDate(today, 1)}T00:00:00`, timezone).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Doctors
// ---------------------------------------------------------------------------

export async function loadDoctors(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  access: BranchAccess,
): Promise<{ rows: DoctorRow[]; branches: BranchOption[]; today: string }> {
  const { today, from, to } = todayWindow(timezone);
  const [
    { all, allowed },
    { data: specialists },
    { data: links },
    { data: services },
    { data: hours },
    { data: departments },
    { data: blocks },
  ] = await Promise.all([
    loadBranches(admin, orgId, access),
    admin
      .from("specialists")
      .select(
        "id, name, title, specialty, department_id, active, licence_number, licence_authority, licence_expires_on, phone_ext, bio, user_id, profiles:profiles!specialists_user_id_fkey(first_name, last_name, email)",
      )
      .eq("org_id", orgId)
      .order("name"),
    admin.from("specialist_locations").select("specialist_id, location_id").eq("org_id", orgId),
    admin.from("specialist_services").select("specialist_id, service_id").eq("org_id", orgId),
    admin
      .from("working_hours")
      .select("specialist_id, location_id, weekday, start_min, end_min")
      .eq("org_id", orgId),
    admin.from("departments").select("id, name").eq("org_id", orgId),
    admin
      .from("time_blocks")
      .select("id, specialist_id, location_id, starts_at, ends_at, reason")
      .eq("org_id", orgId)
      .gte("ends_at", new Date().toISOString())
      .order("starts_at")
      .limit(500),
  ]);

  // Today's appointments per doctor, in the branches this person may see (counts only).
  const counts = new Map<string, number>();
  const appts = await fetchAll<{ specialist_id: string | null; location_id: string | null }>(
    (f, t) =>
      admin
        .from("appointments")
        .select("specialist_id, location_id")
        .eq("org_id", orgId)
        .gte("starts_at", from)
        .lt("starts_at", to)
        .neq("status", "cancelled")
        .not("specialist_id", "is", null)
        .order("id")
        .range(f, t),
  );
  for (const a of appts.data ?? []) {
    if (!a.specialist_id || !canSeeLocation(access, a.location_id)) continue;
    counts.set(a.specialist_id, (counts.get(a.specialist_id) ?? 0) + 1);
  }

  const nameOf = new Map(all.map((l) => [l.id, l.name]));
  const deptName = new Map((departments ?? []).map((d) => [d.id, d.name]));
  const rows: DoctorRow[] = [];
  for (const s of specialists ?? []) {
    const locIds = (links ?? []).filter((l) => l.specialist_id === s.id).map((l) => l.location_id);
    const visibleIds = locIds.filter((id) => canSeeLocation(access, id));
    // Listed when they work in a branch this person may see, or in no branch at all.
    if (locIds.length > 0 && visibleIds.length === 0) continue;
    const myHours = (hours ?? []).filter(
      (h) => h.specialist_id === s.id && canSeeLocation(access, h.location_id),
    );
    rows.push({
      id: s.id,
      name: s.name,
      title: s.title,
      specialty: s.specialty,
      departmentName: s.department_id ? (deptName.get(s.department_id) ?? null) : null,
      active: s.active,
      locationIds: visibleIds,
      locationNames: visibleIds.map((id) => nameOf.get(id) ?? "").filter(Boolean),
      servicesCount: (services ?? []).filter((x) => x.specialist_id === s.id).length,
      licenceNumber: s.licence_number,
      licenceAuthority: s.licence_authority,
      licenceExpiresOn: s.licence_expires_on,
      phoneExt: s.phone_ext,
      bio: s.bio,
      userId: s.user_id,
      userLabel: personLabel(s.profiles),
      todayCount: counts.get(s.id) ?? 0,
      hours: hoursSummary(
        myHours,
        all.filter((l) => visibleIds.includes(l.id)),
      ),
      timeOff: (blocks ?? [])
        .filter((b) => b.specialist_id === s.id && canSeeLocation(access, b.location_id))
        .slice(0, 5)
        .map((b) => ({ id: b.id, startsAt: b.starts_at, endsAt: b.ends_at, reason: b.reason })),
    });
  }
  return { rows, branches: allowed, today };
}

/**
 * One doctor's linked view for the drawer: the next appointments (with `appointments`), this week's rota shifts and
 * the linked staff record (with `hr`). Null when the doctor does not exist or works only in branches the person may not
 * see. Appointments and shifts follow the branch rule; patients are named by first name (with `contacts`) or initials.
 */
export async function loadDoctorDetail(
  admin: AdminClient,
  orgId: string,
  doctorId: string,
  access: BranchAccess,
  opts: { timezone: string; appointments: boolean; contacts: boolean; hr: boolean; limit?: number },
  now: Date = new Date(),
): Promise<DoctorDetail | null> {
  const [{ data: doctor }, { data: links }, { data: staff }, { data: locations }] =
    await Promise.all([
      admin.from("specialists").select("id").eq("org_id", orgId).eq("id", doctorId).maybeSingle(),
      admin
        .from("specialist_locations")
        .select("location_id")
        .eq("org_id", orgId)
        .eq("specialist_id", doctorId),
      admin
        .from("staff_members")
        .select("id, job_title, home_location_id")
        .eq("org_id", orgId)
        .eq("specialist_id", doctorId)
        .is("deleted_at", null)
        .maybeSingle(),
      admin.from("locations").select("id, name, timezone").eq("org_id", orgId),
    ]);
  if (!doctor) return null;
  const locIds = (links ?? []).map((l) => l.location_id);
  if (locIds.length > 0 && !locIds.some((id) => canSeeLocation(access, id))) return null;
  const loc = new Map((locations ?? []).map((l) => [l.id, l]));

  let upcoming: DoctorDetail["upcoming"] = null;
  if (opts.appointments) {
    let q = admin
      .from("appointments")
      .select(
        "id, starts_at, location_id, contact:contacts(full_name, deleted_at), service:services(name)",
      )
      .eq("org_id", orgId)
      .eq("specialist_id", doctorId)
      .gte("starts_at", now.toISOString())
      .not("status", "in", "(cancelled,no_show)")
      .order("starts_at")
      .limit(opts.limit ?? 5);
    const ids = branchFilterIds(access, null);
    if (ids) q = q.or(branchOrFilter(ids));
    const { data } = await q;
    upcoming = (data ?? [])
      .filter((a) => canSeeLocation(access, a.location_id))
      .map((a) => {
        const l = a.location_id ? loc.get(a.location_id) : undefined;
        const contact = a.contact && !a.contact.deleted_at ? a.contact.full_name : null;
        return {
          id: a.id,
          when: formatInTimeZone(
            new Date(a.starts_at),
            l?.timezone || opts.timezone,
            "EEE d MMM, HH:mm",
          ),
          service: a.service?.name ?? null,
          branch: l?.name ?? null,
          patient: patientShortName(contact, opts.contacts),
        };
      });
  }

  let shifts: DoctorDetail["shifts"] = [];
  const monday = weekStart(todayWindow(opts.timezone, now).today);
  const window = monday ? weekWindow(monday, opts.timezone) : null;
  if (staff && window) {
    const { data } = await admin
      .from("rota_shifts")
      .select(SHIFT_COLUMNS)
      .eq("org_id", orgId)
      .eq("staff_member_id", staff.id)
      .gte("starts_at", window.from)
      .lt("starts_at", window.to)
      .order("starts_at")
      .limit(50);
    shifts = (data ?? [])
      .filter((r) => canSeeLocation(access, r.location_id))
      .map(toShift)
      .map((r) => {
        const l = loc.get(r.locationId);
        const tz = l?.timezone || opts.timezone;
        return {
          id: r.id,
          day: formatInTimeZone(new Date(r.startsAt), tz, "EEE d MMM"),
          time: shiftLabel(r, tz),
          branch: l?.name ?? null,
          role: ROTA_ROLE_LABELS[r.roleLabel],
        };
      });
  }

  return {
    upcoming,
    shifts,
    staff:
      opts.hr && staff && canSeeLocation(access, staff.home_location_id)
        ? { id: staff.id, jobTitle: staff.job_title }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

type StaffDb = {
  id: string;
  full_name: string;
  job_title: string | null;
  department_id: string | null;
  home_location_id: string | null;
  manager_staff_id: string | null;
  employment_type: string;
  start_date: string | null;
  end_date: string | null;
  work_email: string | null;
  work_phone: string | null;
  visa_expires_on: string | null;
  licence_number: string | null;
  licence_expires_on: string | null;
  notes: string | null;
  profile_id: string | null;
  specialist_id: string | null;
  deleted_at: string | null;
};

const STAFF_COLUMNS =
  "id, full_name, job_title, department_id, home_location_id, manager_staff_id, employment_type, start_date, end_date, work_email, work_phone, visa_expires_on, licence_number, licence_expires_on, notes, profile_id, specialist_id, deleted_at";

/** Every staff record of the org whose home branch the person may see (archived ones only when asked). */
export async function loadStaff(
  admin: AdminClient,
  orgId: string,
  access: BranchAccess,
  opts: { includeArchived?: boolean } = {},
): Promise<StaffRow[]> {
  const res = await fetchAll<StaffDb>((f, t) => {
    let q = admin.from("staff_members").select(STAFF_COLUMNS).eq("org_id", orgId);
    if (!opts.includeArchived) q = q.is("deleted_at", null);
    return q.order("id").range(f, t);
  });
  const staff = (res.data ?? []).filter((s) => canSeeLocation(access, s.home_location_id));
  const [{ data: locations }, { data: departments }, members, { data: specialists }] =
    await Promise.all([
      admin.from("locations").select("id, name").eq("org_id", orgId),
      admin.from("departments").select("id, name").eq("org_id", orgId),
      loadMemberOptions(admin, orgId),
      admin.from("specialists").select("id, name").eq("org_id", orgId),
    ]);
  const loc = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const dept = new Map((departments ?? []).map((d) => [d.id, d.name]));
  const person = new Map(members.map((m) => [m.value, m.label]));
  const doc = new Map((specialists ?? []).map((s) => [s.id, s.name]));
  // Managers are named from the full list (a manager in a branch this person cannot see still has a name).
  const allNames = new Map((res.data ?? []).map((s) => [s.id, s.full_name]));
  return staff
    .map((s) => ({
      id: s.id,
      fullName: s.full_name,
      jobTitle: s.job_title,
      departmentId: s.department_id,
      departmentName: s.department_id ? (dept.get(s.department_id) ?? null) : null,
      homeLocationId: s.home_location_id,
      homeLocationName: s.home_location_id ? (loc.get(s.home_location_id) ?? null) : null,
      managerStaffId: s.manager_staff_id,
      managerName: s.manager_staff_id ? (allNames.get(s.manager_staff_id) ?? null) : null,
      employmentType: ((EMPLOYMENT_TYPES as readonly string[]).includes(s.employment_type)
        ? s.employment_type
        : "full_time") as EmploymentType,
      startDate: s.start_date,
      endDate: s.end_date,
      workEmail: s.work_email,
      workPhone: s.work_phone,
      visaExpiresOn: s.visa_expires_on,
      licenceNumber: s.licence_number,
      licenceExpiresOn: s.licence_expires_on,
      notes: s.notes,
      profileId: s.profile_id,
      profileLabel: s.profile_id ? (person.get(s.profile_id) ?? null) : null,
      specialistId: s.specialist_id,
      specialistName: s.specialist_id ? (doc.get(s.specialist_id) ?? null) : null,
      archived: !!s.deleted_at,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** One staff member's duties (branch rule on each duty's branch). */
export async function loadDuties(
  admin: AdminClient,
  orgId: string,
  staffId: string,
  access: BranchAccess,
): Promise<DutyRow[]> {
  const { data } = await admin
    .from("staff_duties")
    .select("id, title, frequency, location_id, active")
    .eq("org_id", orgId)
    .eq("staff_member_id", staffId)
    .order("sort_order")
    .order("created_at")
    .limit(500);
  return (data ?? [])
    .filter((d) => canSeeLocation(access, d.location_id))
    .map((d) => ({
      id: d.id,
      title: d.title,
      frequency: d.frequency as DutyFrequency,
      locationId: d.location_id,
      active: d.active,
    }));
}

function toShift(r: {
  id: string;
  staff_member_id: string;
  location_id: string;
  starts_at: string;
  ends_at: string;
  role_label: string;
  room: string | null;
  notes: string | null;
}): ShiftRow {
  return {
    id: r.id,
    staffMemberId: r.staff_member_id,
    locationId: r.location_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    roleLabel: isRotaRole(r.role_label) ? r.role_label : "other",
    room: r.room,
    notes: r.notes,
  };
}

const SHIFT_COLUMNS =
  "id, staff_member_id, location_id, starts_at, ends_at, role_label, room, notes";

/** Shifts of one branch that start inside [from, to). The caller checked the branch is visible. */
export async function loadBranchShifts(
  admin: AdminClient,
  orgId: string,
  locationId: string,
  window: { from: string; to: string },
): Promise<ShiftRow[]> {
  const res = await fetchAll<Parameters<typeof toShift>[0]>((f, t) =>
    admin
      .from("rota_shifts")
      .select(SHIFT_COLUMNS)
      .eq("org_id", orgId)
      .eq("location_id", locationId)
      .gte("starts_at", window.from)
      .lt("starts_at", window.to)
      .order("starts_at")
      .order("id")
      .range(f, t),
  );
  return (res.data ?? []).map(toShift);
}

/** One person's upcoming shifts (next 28 days) in the branches the viewer may see. */
export async function loadStaffShifts(
  admin: AdminClient,
  orgId: string,
  staffId: string,
  access: BranchAccess,
  now: Date = new Date(),
): Promise<ShiftRow[]> {
  const { data } = await admin
    .from("rota_shifts")
    .select(SHIFT_COLUMNS)
    .eq("org_id", orgId)
    .eq("staff_member_id", staffId)
    .gte("ends_at", now.toISOString())
    .lt("starts_at", new Date(now.getTime() + 28 * 86_400_000).toISOString())
    .order("starts_at")
    .limit(200);
  return (data ?? []).filter((r) => canSeeLocation(access, r.location_id)).map(toShift);
}
