"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/** Cost centres (Phase 22A), accounting.coa.manage. Deactivated, never deleted. Audited. */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const schema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(v), "Codes are up to 20 letters or digits."),
  name: z.string().trim().min(1, "Enter a name.").max(80),
  active: z.string().optional(),
});

export async function saveCostCentre(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = { code: v.code, name: v.name, active: v.id ? v.active === "on" : true };
  const { data, error } = v.id
    ? await admin
        .from("acc_cost_centres")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_cost_centres")
        .insert({ ...row, org_id: member.orgId })
        .select("id")
        .single();
  if (error || !data) return fail(rpcErrorMessage(error, "The cost centre could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.cost_centre.updated" : "accounting.cost_centre.created",
    entity: "acc_cost_centres",
    entityId: data.id,
    diff: { code: row.code, active: row.active },
  });
  revalidatePath("/accounting/cost-centres");
  return { ok: true, message: "Cost centre saved." };
}
