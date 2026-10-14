"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can, canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { doctorProfileSchema, type DoctorProfileInput } from "@/lib/organisation/doctors";
import { loadDoctorDetail } from "@/lib/organisation/server";
import type { DoctorDetail } from "@/lib/organisation/types";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };
export type DetailResult = { ok: true; data: DoctorDetail } | { ok: false; error: string };

const EDIT_PERMS = ["settings.manage", "hr.manage"] as const;

/**
 * Edits a doctor's profile and licence fields (specialty, licence number, authority and expiry, extension, short
 * bio). Needs settings.manage or hr.manage, and the doctor must work in a branch the person may see (or in none).
 * Working hours, services and branches stay under Settings, Appointments. Audited with the changed field names
 * only (no values).
 */
export async function updateDoctorProfileAction(
  id: string,
  raw: DoctorProfileInput,
): Promise<ActionResult> {
  const member = await requireMember();
  if (!canAny(member, EDIT_PERMS))
    return { ok: false, error: "You do not have permission to edit doctors." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const parsed = doctorProfileSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the fields." };

  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("specialists")
    .select("id, specialty, licence_number, licence_authority, licence_expires_on, phone_ext, bio")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return { ok: false, error: "This doctor no longer exists." };

  const { data: links } = await admin
    .from("specialist_locations")
    .select("location_id")
    .eq("org_id", member.orgId)
    .eq("specialist_id", id);
  const access = readBranchAccess(member);
  const locIds = (links ?? []).map((l) => l.location_id);
  if (locIds.length > 0 && !locIds.some((l) => canSeeLocation(access, l)))
    return { ok: false, error: "This doctor works only in branches you cannot see." };

  const next = parsed.data;
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
    (k) => (current[k] ?? null) !== (next[k] ?? null),
  );
  if (changed.length === 0) return { ok: true, message: "Nothing to save." };

  const { error } = await admin
    .from("specialists")
    .update(next)
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the doctor." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "doctor.profile_updated",
    entity: "specialist",
    entityId: id,
    diff: { fields: changed } as Json,
  });
  revalidatePath("/doctors");
  return { ok: true, message: "Saved." };
}

/**
 * The doctor drawer's linked view: the next five appointments (appointments.view; patients by first name with
 * contacts.view, otherwise initials), this week's shifts and the linked staff record (hr.view). Read-only; follows the
 * branch rule. The appointment list is logged as a list view (ids and counts only).
 */
export async function loadDoctorDetailAction(id: string): Promise<DetailResult> {
  const member = await requireMember();
  if (!canAny(member, ["appointments.view", "hr.view"]))
    return { ok: false, error: "You do not have permission to see doctors." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const admin = createAdminClient();
  const detail = await loadDoctorDetail(admin, member.orgId, id, readBranchAccess(member), {
    timezone: member.org.timezone || "Asia/Dubai",
    appointments: can(member, "appointments.view"),
    contacts: can(member, "contacts.view"),
    hr: can(member, "hr.view"),
  });
  if (!detail) return { ok: false, error: "This doctor no longer exists." };
  if (detail.upcoming?.length)
    await recordAccess(admin, member, {
      entity: "appointment",
      action: "list",
      detail: { page: "doctors", count: detail.upcoming.length },
    });
  return { ok: true, data: detail };
}
