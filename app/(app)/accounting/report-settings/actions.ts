"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The accounting report thresholds (Phase 22G), accounting.settings.manage: the budget variance highlight, the large
 * manual journal amount and the corporate tax bridge's rate, 0% band, entertainment share, Small Business Relief limit
 * and connected-person disclosure limit. Stored in fin_ref_finance_settings (one row per org). Audited.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const money = (max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/,/g, ""))
    .refine(
      (v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= max,
      "Enter an amount (at most two decimals).",
    )
    .transform(Number);
const percent = z.coerce.number().min(0, "0 to 100").max(100, "0 to 100");

const schema = z.object({
  acc_budget_variance_pct: z.coerce.number().min(0).max(1000),
  acc_large_journal_amount: money(1e12).refine((v) => v > 0, "Enter an amount above zero."),
  acc_ct_rate: percent,
  acc_ct_threshold: money(1e12),
  acc_ct_entertainment_pct: percent,
  acc_ct_sbr_limit: money(1e14),
  acc_ct_connected_limit: money(1e12),
});

export async function saveReportSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.settings.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...p.data }, { onConflict: "org_id" });
  if (error) return fail("The settings could not be saved.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.report_settings.updated",
    entity: "fin_ref_finance_settings",
    diff: p.data,
  });
  revalidatePath("/accounting/report-settings");
  return { ok: true, message: "Settings saved." };
}
