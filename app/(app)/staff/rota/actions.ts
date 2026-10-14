"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { ROTA_ROLES, shiftRange } from "@/lib/organisation/rota";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Rota shifts (Phase C). hr.manage only; the branch must be one the person may see. The database refuses a shift that
 * overlaps another of the same person (app.rota_shifts_no_overlap, under a per-person lock): that refusal is shown
 * as is, never retried around. Audited with ids only.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v?.trim() ? v.trim() : null));

const shiftSchema = z.object({
  id: z.string().uuid().nullish(),
  staffMemberId: z.string().uuid(),
  locationId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  roleLabel: z.enum(ROTA_ROLES),
  room: optionalText(40),
  notes: optionalText(300),
});
export type ShiftInput = z.input<typeof shiftSchema>;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export async function saveShiftAction(raw: ShiftInput): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  const parsed = shiftSchema.safeParse(raw);
  if (!parsed.success) return fail("Check the date and times.");
  const v = parsed.data;
  const access = readBranchAccess(member);
  if (!canSeeLocation(access, v.locationId)) return fail("You cannot plan shifts in that branch.");

  const admin = createAdminClient(member.userId);
  const [{ data: location }, { data: staff }] = await Promise.all([
    admin
      .from("locations")
      .select("id, timezone")
      .eq("org_id", member.orgId)
      .eq("id", v.locationId)
      .maybeSingle(),
    admin
      .from("staff_members")
      .select("id, home_location_id, deleted_at")
      .eq("org_id", member.orgId)
      .eq("id", v.staffMemberId)
      .maybeSingle(),
  ]);
  if (!location) return fail("That branch no longer exists.");
  if (!staff || staff.deleted_at) return fail("Choose an active staff member.");

  const range = shiftRange(v.date, v.start, v.end, location.timezone || "Asia/Dubai");
  if (!range) return fail("A shift needs a start and end time and can last at most 24 hours.");

  if (v.id) {
    const { data: existing } = await admin
      .from("rota_shifts")
      .select("id, location_id")
      .eq("org_id", member.orgId)
      .eq("id", v.id)
      .maybeSingle();
    if (!existing || !canSeeLocation(access, existing.location_id))
      return fail("This shift no longer exists.");
  }

  const row = {
    location_id: v.locationId,
    staff_member_id: v.staffMemberId,
    starts_at: range.startsAt,
    ends_at: range.endsAt,
    role_label: v.roleLabel,
    room: v.room,
    notes: v.notes,
  };
  const res = v.id
    ? await admin
        .from("rota_shifts")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .select("id")
        .single()
    : await admin
        .from("rota_shifts")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (res.error || !res.data) {
    if (res.error?.code === "23P01")
      return fail("This person already has a shift that overlaps this time.");
    if (res.error?.hint === "staff_archived")
      return fail("This person is archived; restore them before adding shifts.");
    return fail("Could not save the shift.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "rota.shift_updated" : "rota.shift_added",
    entity: "rota_shift",
    entityId: res.data.id,
    diff: { staff_member_id: v.staffMemberId, location_id: v.locationId } as Json,
  });
  revalidatePath("/staff/rota");
  return { ok: true, message: "Shift saved." };
}

export async function deleteShiftAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("hr.manage");
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid shift.");
  const admin = createAdminClient(member.userId);
  const { data: existing } = await admin
    .from("rota_shifts")
    .select("id, location_id, staff_member_id")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!existing || !canSeeLocation(readBranchAccess(member), existing.location_id))
    return fail("This shift no longer exists.");
  const { error } = await admin
    .from("rota_shifts")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id);
  if (error) return fail("Could not remove the shift.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "rota.shift_removed",
    entity: "rota_shift",
    entityId: id,
    diff: { staff_member_id: existing.staff_member_id, location_id: existing.location_id } as Json,
  });
  revalidatePath("/staff/rota");
  return { ok: true, message: "Shift removed." };
}
