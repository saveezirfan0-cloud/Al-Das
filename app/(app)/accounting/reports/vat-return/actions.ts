"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { EMIRATES } from "@/lib/accounting/accounts";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * VAT return settings per entity (Phase 22G), accounting.tax.manage: monthly or quarterly periods, the month a quarter
 * starts in (as on the VAT certificate) and the emirate used for a line that names no branch. Audited.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const schema = z.object({
  entity_id: uuid,
  vat_period_months: z.enum(["1", "3"]),
  vat_period_anchor_month: z.coerce.number().int().min(1).max(12),
  default_emirate: z.enum(EMIRATES),
});

export async function saveVatSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.tax.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin
    .from("acc_entities")
    .update({
      vat_period_months: Number(p.data.vat_period_months),
      vat_period_anchor_month: p.data.vat_period_anchor_month,
      default_emirate: p.data.default_emirate,
    })
    .eq("id", p.data.entity_id)
    .eq("org_id", member.orgId)
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("The VAT settings could not be saved.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.vat_settings.updated",
    entity: "acc_entities",
    entityId: data.id,
    diff: {
      vat_period_months: Number(p.data.vat_period_months),
      vat_period_anchor_month: p.data.vat_period_anchor_month,
      default_emirate: p.data.default_emirate,
    },
  });
  revalidatePath("/accounting/reports/vat-return");
  return { ok: true, data: undefined, message: "VAT settings saved." };
}
