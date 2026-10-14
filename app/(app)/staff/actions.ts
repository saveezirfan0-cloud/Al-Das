"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { loadDuties, loadStaffShifts } from "@/lib/organisation/server";
import { organisationSettingsSchema, writeOrganisationSettings } from "@/lib/organisation/settings";
import {
  dutyInputSchema,
  managerLoop,
  normaliseWorkPhone,
  staffInputSchema,
  type DutyInput,
  type StaffInput,
} from "@/lib/organisation/staff";
import type { DutyRow, ShiftRow } from "@/lib/organisation/types";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Staff (Phase C): HR records, duties and the reminder setting. Reads need hr.view, writes hr.manage; every write
 * runs through the service role after that check, is limited to staff whose home branch the person may see, and is
 * audited with field names and counts only (never names, dates or contact details). Archive is a soft delete
 * (deleted_at): the record, its duties and its shifts stay, and Restore brings it back. No pay fields exist here.
 */

export type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function refresh() {
  revalidatePath("/staff");
  revalidatePath("/staff/rota");
}

type Target = { id: string; home_location_id: string | null; deleted_at: string | null };

/** The staff record, when it is in this org and in a branch the person may see. */
async function loadTarget(
  admin: AdminClient,
  orgId: string,
  id: string,
  access: ReturnType<typeof readBranchAccess>,
): Promise<Target | null> {
  if (!uuid.safeParse(id).success) return null;
  const { data } = await admin
    .from("staff_members")
    .select("id, home_location_id, deleted_at")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data || !canSeeLocation(access, data.home_location_id)) return null;
  return data;
}

/** Create (id null) or edit a staff record. */
export async function saveStaffAction(
  id: string | null,
  raw: StaffInput,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("hr.manage");
  const parsed = staffInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the fields.");
  const values = parsed.data;
  let phone: string | null;
  try {
    phone = normaliseWorkPhone(values.work_phone);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The work phone is not a valid number.");
  }
  const access = readBranchAccess(member);
  if (!canSeeLocation(access, values.home_location_id))
    return fail("You cannot place staff in that branch.");

  const admin = createAdminClient(member.userId);
  if (id) {
    const target = await loadTarget(admin, member.orgId, id, access);
    if (!target) return fail("This staff record no longer exists.");
  }

  // The manager must be another active staff record of this org, and never someone this person manages.
  if (values.manager_staff_id) {
    if (values.manager_staff_id === id) return fail("A person cannot be their own manager.");
    const { data: all } = await admin
      .from("staff_members")
      .select("id, manager_staff_id, deleted_at")
      .eq("org_id", member.orgId)
      .limit(1000);
    const mgr = (all ?? []).find((s) => s.id === values.manager_staff_id);
    if (!mgr || mgr.deleted_at) return fail("Choose an active manager.");
    if (
      id &&
      managerLoop(
        id,
        values.manager_staff_id,
        new Map((all ?? []).map((s) => [s.id, s.manager_staff_id])),
      )
    )
      return fail("That manager reports to this person; choose someone else.");
  }

  const row = {
    full_name: values.full_name,
    job_title: values.job_title,
    department_id: values.department_id,
    home_location_id: values.home_location_id,
    manager_staff_id: values.manager_staff_id,
    profile_id: values.profile_id,
    specialist_id: values.specialist_id,
    employment_type: values.employment_type,
    start_date: values.start_date,
    end_date: values.end_date,
    work_email: values.work_email,
    work_phone: phone,
    visa_expires_on: values.visa_expires_on,
    licence_number: values.licence_number,
    licence_expires_on: values.licence_expires_on,
    notes: values.notes,
  };

  const res = id
    ? await admin
        .from("staff_members")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", id)
        .select("id")
        .single()
    : await admin
        .from("staff_members")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (res.error || !res.data) {
    const code = res.error?.code;
    if (code === "23505")
      return fail("That Pulse user or doctor is already linked to another staff record.");
    if (code === "23514" && res.error?.hint === "profile_not_member")
      return fail("The linked user is not a member of this organisation.");
    if (code === "23514") return fail("One of the chosen items belongs to another organisation.");
    return fail("Could not save the staff record.");
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "staff.updated" : "staff.created",
    entity: "staff_member",
    entityId: res.data.id,
    diff: { fields: Object.keys(row).filter((k) => row[k as keyof typeof row] !== null) } as Json,
  });
  refresh();
  return { ok: true, message: id ? "Saved." : "Staff member added.", data: { id: res.data.id } };
}

/** Archive (soft delete) or restore a staff record. Their duties and shifts stay. */
export async function setStaffArchivedAction(id: string, archived: boolean): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  const admin = createAdminClient(member.userId);
  const target = await loadTarget(admin, member.orgId, id, readBranchAccess(member));
  if (!target) return fail("This staff record no longer exists.");
  if (!!target.deleted_at === archived)
    return { ok: true, message: archived ? "Already archived." : "Already active." };
  const { error } = await admin
    .from("staff_members")
    .update({ deleted_at: archived ? new Date().toISOString() : null })
    .eq("org_id", member.orgId)
    .eq("id", id);
  if (error)
    return fail(
      error.code === "23505"
        ? "Another active record is linked to the same user or doctor; unlink it first."
        : "Could not change the record.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: archived ? "staff.archived" : "staff.restored",
    entity: "staff_member",
    entityId: id,
  });
  refresh();
  return { ok: true, message: archived ? "Archived." : "Restored." };
}

/** One staff member's duties. */
export async function listDutiesAction(staffId: string): Promise<ActionResult<DutyRow[]>> {
  const member = await requirePerm("hr.view");
  const admin = createAdminClient();
  const access = readBranchAccess(member);
  const target = await loadTarget(admin, member.orgId, staffId, access);
  if (!target) return fail("This staff record no longer exists.");
  return { ok: true, data: await loadDuties(admin, member.orgId, staffId, access) };
}

/** Add (dutyId null) or edit a duty on a staff member's checklist. */
export async function saveDutyAction(
  staffId: string,
  dutyId: string | null,
  raw: DutyInput,
): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  const parsed = dutyInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the duty.");
  const access = readBranchAccess(member);
  if (!canSeeLocation(access, parsed.data.location_id)) return fail("You cannot use that branch.");
  const admin = createAdminClient(member.userId);
  const target = await loadTarget(admin, member.orgId, staffId, access);
  if (!target) return fail("This staff record no longer exists.");
  if (dutyId && !uuid.safeParse(dutyId).success) return fail("Invalid duty.");

  const res = dutyId
    ? await admin
        .from("staff_duties")
        .update(parsed.data)
        .eq("org_id", member.orgId)
        .eq("staff_member_id", staffId)
        .eq("id", dutyId)
        .select("id")
        .maybeSingle()
    : await admin
        .from("staff_duties")
        .insert({ ...parsed.data, org_id: member.orgId, staff_member_id: staffId })
        .select("id")
        .single();
  if (res.error || !res.data) return fail("Could not save the duty.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: dutyId ? "staff.duty_updated" : "staff.duty_added",
    entity: "staff_duty",
    entityId: res.data.id,
    diff: { staff_member_id: staffId } as Json,
  });
  return { ok: true, message: "Saved." };
}

export async function deleteDutyAction(staffId: string, dutyId: string): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  if (!uuid.safeParse(dutyId).success) return fail("Invalid duty.");
  const admin = createAdminClient(member.userId);
  const target = await loadTarget(admin, member.orgId, staffId, readBranchAccess(member));
  if (!target) return fail("This staff record no longer exists.");
  const { data, error } = await admin
    .from("staff_duties")
    .delete()
    .eq("org_id", member.orgId)
    .eq("staff_member_id", staffId)
    .eq("id", dutyId)
    .select("id");
  if (error) return fail("Could not remove the duty.");
  if (!data?.length) return fail("This duty no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "staff.duty_removed",
    entity: "staff_duty",
    entityId: dutyId,
    diff: { staff_member_id: staffId } as Json,
  });
  return { ok: true, message: "Removed." };
}

/** A staff member's shifts for the next four weeks (the Rota tab). */
export async function listStaffShiftsAction(staffId: string): Promise<ActionResult<ShiftRow[]>> {
  const member = await requirePerm("hr.view");
  const admin = createAdminClient();
  const access = readBranchAccess(member);
  const target = await loadTarget(admin, member.orgId, staffId, access);
  if (!target) return fail("This staff record no longer exists.");
  return { ok: true, data: await loadStaffShifts(admin, member.orgId, staffId, access) };
}

/** Days before a visa or licence expires that the daily reminder is raised (orgs.settings.organisation). */
export async function saveReminderDaysAction(days: number): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  const parsed = organisationSettingsSchema.safeParse({ expiry_lead_days: days });
  if (!parsed.success) return fail("Choose between 1 and 180 days.");
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const { error } = await admin
    .from("orgs")
    .update({
      settings: writeOrganisationSettings(org?.settings, parsed.data) as NonNullable<Json>,
    })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the setting.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "staff.reminder_days_changed",
    entity: "org",
    entityId: member.orgId,
    diff: { expiry_lead_days: parsed.data.expiry_lead_days } as Json,
  });
  refresh();
  revalidatePath("/doctors");
  return { ok: true, message: "Saved." };
}
