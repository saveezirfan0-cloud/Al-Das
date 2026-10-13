"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  dbMessage,
  fail,
  firstIssue,
  optionalDate,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { OWNER_ROLES, parseStatusList } from "@/lib/finance/blueprint-settings";
import { DENIAL_CATEGORIES } from "@/lib/finance/denials";
import { parseDaySteps } from "@/lib/finance/followup";
import { parsePriceText } from "@/lib/finance/payer-prices";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Finance workflow settings: thresholds, the denial reason-code taxonomy and the payers' agreed price lists. Needs
 * finance.reference.manage. Writes use the member's own client so row level security decides (the same model as the other
 * reference tables), and every change is audited.
 */

const PERM = "finance.reference.manage";
const refresh = () => revalidatePath("/finance/workflow-settings");
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const thresholds = z.object({
  preauth_expiry_lead_days: int(0, 180),
  preauth_task_enabled: checkbox,
  ready_start_date: optionalDate,
  ready_grace_days: int(0, 60),
  denial_cases_start_date: optionalDate,
  denial_default_resubmit_days: int(1, 365),
  denial_warn_days: int(0, 90),
  denial_task_enabled: checkbox,
  short_pay_tolerance_amount: num(0, 1e6),
  short_pay_tolerance_pct_percent: num(0, 100),
  scorecard_min_claims: int(1, 100000),
  scorecard_denial_rate_warn_percent: num(0, 100),
  scorecard_denial_rate_alert_percent: num(0, 100),
  scorecard_days_to_pay_warn: int(1, 730),
  scorecard_days_to_pay_alert: int(1, 730),
  forecast_horizon_weeks: int(1, 52),
  forecast_default_lag_days: int(1, 730),
  forecast_default_collection_rate_percent: num(0, 100),
  forecast_min_history: int(1, 100000),
  forecast_tail_weeks: int(1, 52),
  cashup_variance_tolerance: num(0, 1e6),
});

export async function saveThresholds(raw: Record<string, string>): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = thresholds.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the numbers and dates."));
  const d = p.data;
  if (d.scorecard_denial_rate_alert_percent < d.scorecard_denial_rate_warn_percent)
    return fail("The red denial rate cannot be below the amber one.");
  if (d.scorecard_days_to_pay_alert < d.scorecard_days_to_pay_warn)
    return fail("The red days-to-pay cannot be below the amber one.");
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_finance_settings")
    .update({
      preauth_expiry_lead_days: d.preauth_expiry_lead_days,
      preauth_task_enabled: d.preauth_task_enabled,
      ready_start_date: d.ready_start_date,
      ready_grace_days: d.ready_grace_days,
      denial_cases_start_date: d.denial_cases_start_date,
      denial_default_resubmit_days: d.denial_default_resubmit_days,
      denial_warn_days: d.denial_warn_days,
      denial_task_enabled: d.denial_task_enabled,
      short_pay_tolerance_amount: d.short_pay_tolerance_amount,
      short_pay_tolerance_pct: d.short_pay_tolerance_pct_percent / 100,
      scorecard_min_claims: d.scorecard_min_claims,
      scorecard_denial_rate_warn: d.scorecard_denial_rate_warn_percent / 100,
      scorecard_denial_rate_alert: d.scorecard_denial_rate_alert_percent / 100,
      scorecard_days_to_pay_warn: d.scorecard_days_to_pay_warn,
      scorecard_days_to_pay_alert: d.scorecard_days_to_pay_alert,
      forecast_horizon_weeks: d.forecast_horizon_weeks,
      forecast_default_lag_days: d.forecast_default_lag_days,
      forecast_default_collection_rate: d.forecast_default_collection_rate_percent / 100,
      forecast_min_history: d.forecast_min_history,
      forecast_tail_weeks: d.forecast_tail_weeks,
      cashup_variance_tolerance: d.cashup_variance_tolerance,
    })
    .eq("org_id", member.orgId);
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.thresholds_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: {
      ready_check: d.ready_start_date !== null,
      denial_cases: d.denial_cases_start_date !== null,
    },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}

const blueprint = z.object({
  doctor_basis: z.enum(["", "ordering", "performing"]),
  accepted_claim_statuses: z.string().max(2000),
  evidence_start_date: optionalDate,
  evidence_grace_days: int(0, 30),
  escalation_days: int(1, 365),
  escalation_role: z.enum(OWNER_ROLES as unknown as [string, ...string[]]),
});

/** Integration Blueprint settings: doctor basis, evidenced claim statuses, completion evidence, escalation. */
export async function saveBlueprintSettings(raw: Record<string, string>): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = blueprint.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the values."));
  const d = p.data;
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_finance_settings")
    .update({
      doctor_basis: d.doctor_basis === "" ? null : d.doctor_basis,
      accepted_claim_statuses: parseStatusList(d.accepted_claim_statuses),
      evidence_start_date: d.evidence_start_date,
      evidence_grace_days: d.evidence_grace_days,
      escalation_days: d.escalation_days,
      escalation_role: d.escalation_role,
    })
    .eq("org_id", member.orgId);
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.blueprint_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: {
      doctor_basis: d.doctor_basis || null,
      statuses: parseStatusList(d.accepted_claim_statuses).length,
      evidence_check: d.evidence_start_date !== null,
      escalation_days: d.escalation_days,
      escalation_role: d.escalation_role,
    },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}

const followupSchema = z.object({
  ageing_bucket_days: z.string().max(100),
  followup_stage_days: z.string().max(100),
  followup_start_date: optionalDate,
  followup_task_enabled: checkbox,
  followup_task_role: z.string().trim().min(1, "Name the role that gets the tasks.").max(60),
  followup_task_due_days: int(0, 60),
});

/** Phase 20I: ageing buckets, follow-up stages and the follow-up tasks (off until a start date is set). */
export async function saveFollowupSettings(raw: Record<string, string>): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = followupSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the values."));
  const d = p.data;
  const buckets = parseDaySteps(d.ageing_bucket_days, 8);
  if (!buckets)
    return fail(
      "Ageing buckets: 1 to 8 whole days in increasing order, for example 30, 60, 90, 120.",
    );
  const stages = parseDaySteps(d.followup_stage_days, 6);
  if (!stages)
    return fail(
      "Follow-up stages: 1 to 6 whole days in increasing order, for example 60, 90, 120.",
    );
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_finance_settings")
    .update({
      ageing_bucket_days: buckets,
      followup_stage_days: stages,
      followup_start_date: d.followup_start_date,
      followup_task_enabled: d.followup_task_enabled,
      followup_task_role: d.followup_task_role,
      followup_task_due_days: d.followup_task_due_days,
    })
    .eq("org_id", member.orgId);
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.followup_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: {
      buckets,
      stages,
      tasks_on: d.followup_start_date !== null && d.followup_task_enabled,
      start_date: d.followup_start_date,
      due_days: d.followup_task_due_days,
    },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Enter the code.")
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash and underscore."),
  is_family: checkbox,
  description: z.string().trim().min(1, "Describe what the code means.").max(200),
  category: z.enum(DENIAL_CATEGORIES),
  default_owner_role: z.enum(["insurance", "billing", "finance", "admin"]),
  resubmit_days: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 365),
      "Days must be 1 to 365.",
    ),
  appealable: checkbox,
  active: checkbox,
});

export async function saveDenialCode(raw: Record<string, string>): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = codeSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const code = p.data.code.toUpperCase();
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_denial_codes")
    .upsert(
      { org_id: member.orgId, ...p.data, code, is_placeholder: false },
      { onConflict: "org_id,code" },
    );
  if (error) return fail(dbMessage(error, "Could not save the code."));
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.denial_code_saved",
    entity: "fin_ref_denial_codes",
    entityId: code,
  });
  refresh();
  return { ok: true, message: "Code saved." };
}

export async function deleteDenialCode(code: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(code)) return fail("Invalid code.");
  const { data, error } = await (
    await createClient()
  )
    .from("fin_ref_denial_codes")
    .delete()
    .eq("org_id", member.orgId)
    .eq("code", code)
    .select("code");
  if (error || !data?.length) return fail("Could not remove the code.");
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.denial_code_removed",
    entity: "fin_ref_denial_codes",
    entityId: code,
  });
  refresh();
  return { ok: true, message: "Code removed." };
}

const priceFormSchema = z.object({
  payer_id: z.string().trim().min(1, "Enter the payer ID.").max(60),
  text: z.string().max(400_000),
});

/** Replaces or adds prices for one payer from pasted lines ("CPT, price[, effective from]"). */
export async function importPayerPrices(
  raw: Record<string, string>,
): Promise<ActionResult<{ saved: number; errors: number }>> {
  const member = await requirePerm(PERM);
  const p = priceFormSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const parsed = parsePriceText(p.data.text);
  if (parsed.errors.length > 0 && parsed.rows.length === 0)
    return fail(
      `Nothing was imported: ${parsed.errors.length} line(s) have a problem (first: line ${parsed.errors[0].line}, ${parsed.errors[0].code.replaceAll("_", " ")}).`,
    );
  if (parsed.rows.length === 0)
    return fail("Paste at least one line: the CPT code, then the agreed price.");
  const supabase = await createClient();
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const { error } = await supabase.from("fin_ref_payer_prices").upsert(
      parsed.rows
        .slice(i, i + 500)
        .map((r) => ({ org_id: member.orgId, payer_id: p.data.payer_id, ...r })),
      { onConflict: "org_id,payer_id,cpt_code,effective_from" },
    );
    if (error) return fail(dbMessage(error, "Could not save the prices."));
  }
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.prices_imported",
    entity: "fin_ref_payer_prices",
    entityId: p.data.payer_id,
    diff: { rows: parsed.rows.length, errors: parsed.errors.length },
  });
  refresh();
  return {
    ok: true,
    data: { saved: parsed.rows.length, errors: parsed.errors.length },
    message: `${parsed.rows.length} price(s) saved${parsed.errors.length ? `, ${parsed.errors.length} line(s) skipped` : ""}.`,
  };
}

export async function deletePayerPrice(id: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return fail("Invalid price.");
  const { data, error } = await (
    await createClient()
  )
    .from("fin_ref_payer_prices")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id");
  if (error || !data?.length) return fail("Could not remove the price.");
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.workflow.price_removed",
    entity: "fin_ref_payer_prices",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Price removed." };
}
