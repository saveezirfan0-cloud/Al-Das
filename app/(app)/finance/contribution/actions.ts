"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, dbMessage, fail, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Links a Unite report doctor (doctor_key) to a DHA licence id, so the contribution page can find that doctor's loaded
 * pay and charges. Needs finance.costs.manage (and finance.profit.view: the links are made from that page); every change
 * is audited (keys and ids only). The table is service-only, so these actions are the one way to change it.
 */

const doctorKey = z.string().trim().min(1).max(200);
const dhaId = z.string().trim().min(1).max(40);

async function reportHasDoctor(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  key: string,
): Promise<boolean> {
  const { data } = await admin
    .from("fin_report_visits")
    .select("id")
    .eq("org_id", orgId)
    .eq("doctor_key", key)
    .eq("is_current", true)
    .limit(1);
  return (data ?? []).length > 0;
}

export async function linkReportDoctor(rawKey: string, rawDhaId: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.costs.manage") || !can(member, "finance.profit.view"))
    return fail(DENIED);
  const key = doctorKey.safeParse(rawKey);
  const dha = dhaId.safeParse(rawDhaId);
  if (!key.success) return fail("Choose a doctor from the report.");
  if (!dha.success) return fail("Choose a DHA id.");

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  if (!(await reportHasDoctor(admin, member.orgId, key.data)))
    return fail("That doctor is not in the Unite report.");
  const { data: ref } = await admin
    .from("fin_ref_doctors")
    .select("dha_id")
    .eq("org_id", member.orgId)
    .eq("dha_id", dha.data)
    .maybeSingle();
  if (!ref) return fail("That DHA id is not in the doctor list.");

  const { error } = await admin.from("fin_report_doctor_map").upsert(
    {
      org_id: member.orgId,
      doctor_key: key.data,
      dha_id: ref.dha_id,
      created_by: member.userId,
    },
    { onConflict: "org_id,doctor_key" },
  );
  if (error) return fail(dbMessage(error, "Could not link the doctor."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.contribution.doctor_linked",
    entity: "fin_report_doctor_map",
    entityId: member.orgId,
    diff: { doctor_key: key.data, dha_id: ref.dha_id },
  });
  revalidatePath("/finance/contribution");
  return { ok: true, message: "Doctor linked." };
}

export async function unlinkReportDoctor(rawKey: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.costs.manage") || !can(member, "finance.profit.view"))
    return fail(DENIED);
  const key = doctorKey.safeParse(rawKey);
  if (!key.success) return fail("Choose a doctor.");

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin
    .from("fin_report_doctor_map")
    .delete()
    .eq("org_id", member.orgId)
    .eq("doctor_key", key.data)
    .select("dha_id");
  if (error) return fail(dbMessage(error, "Could not remove the link."));
  if (!data || data.length === 0) return fail("That doctor is not linked.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.contribution.doctor_unlinked",
    entity: "fin_report_doctor_map",
    entityId: member.orgId,
    diff: { doctor_key: key.data, dha_id: data[0].dha_id },
  });
  revalidatePath("/finance/contribution");
  return { ok: true, message: "Link removed." };
}
