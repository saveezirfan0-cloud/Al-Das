"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Capacity (M3): linking a Unite report doctor key to a Pulse doctor (finance.reference.manage) and the room opening
 * hours setting (finance.targets.manage). Writes use the service role after the check and are audited.
 */

const refresh = () => revalidatePath("/finance/capacity");

const linkSchema = z.object({
  doctor_key: z.string().trim().min(1, "Choose a Unite doctor.").max(200),
  specialist_id: z.string().uuid("Choose a Pulse doctor."),
});

export async function linkDoctorKey(values: Record<string, string>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.reference.manage")) return fail(DENIED);
  const parsed = linkSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);

  // Only a key the org's own Unite report uses, and only a doctor of this org.
  const [{ data: seen }, { data: doctor }] = await Promise.all([
    admin
      .from("fin_report_visits")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("doctor_key", parsed.data.doctor_key)
      .limit(1),
    admin
      .from("specialists")
      .select("id")
      .eq("id", parsed.data.specialist_id)
      .eq("org_id", member.orgId)
      .maybeSingle(),
  ]);
  if (!seen || seen.length === 0) return fail("That doctor is not in any Unite report upload.");
  if (!doctor) return fail("Doctor not found.");

  const { error } = await admin.from("fin_ref_doctor_keys").upsert(
    {
      org_id: member.orgId,
      doctor_key: parsed.data.doctor_key,
      specialist_id: parsed.data.specialist_id,
      created_by: member.userId,
    },
    { onConflict: "org_id,doctor_key" },
  );
  if (error) return fail("Could not save the link.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.doctor_key_linked",
    entity: "fin_ref_doctor_keys",
    entityId: parsed.data.specialist_id,
    diff: { doctor_key: parsed.data.doctor_key, specialist_id: parsed.data.specialist_id },
  });
  refresh();
  return { ok: true, message: "Doctor linked." };
}

export async function unlinkDoctorKey(doctorKey: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.reference.manage")) return fail(DENIED);
  const key = z.string().trim().min(1).max(200).safeParse(doctorKey);
  if (!key.success) return fail("Invalid doctor.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_doctor_keys")
    .delete()
    .eq("org_id", member.orgId)
    .eq("doctor_key", key.data)
    .select("specialist_id");
  if (error) return fail("Could not remove the link.");
  if (!data || data.length === 0) return fail("Link not found.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.doctor_key_unlinked",
    entity: "fin_ref_doctor_keys",
    entityId: data[0].specialist_id,
    diff: { doctor_key: key.data },
  });
  refresh();
  return { ok: true, message: "Link removed." };
}

const openHoursSchema = z.object({
  room_open_hours_per_day: z.coerce
    .number({ message: "Hours must be a number." })
    .gt(0, "Hours must be more than 0.")
    .max(24, "Hours must be at most 24.")
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most two decimals."),
});

export async function saveRoomOpenHours(values: Record<string, string>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.targets.manage")) return fail(DENIED);
  const parsed = openHoursSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail("Could not save the opening hours.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.room_open_hours_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  return { ok: true, message: "Opening hours saved." };
}
