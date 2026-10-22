"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  type ActionResult,
} from "@/lib/finance/action-support";
import { dqSettingsSchema } from "@/lib/finance/collections";
import { perfSettingsSchema } from "@/lib/finance/doctor-performance";
import {
  daysInMonth,
  LINE_CODE_RE,
  monthOf,
  parseOperatingDays,
  parseTargetInput,
} from "@/lib/finance/flash";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { reconSettingsSchema } from "@/lib/finance/insurance-billing";
import { mgmtAlertSettingsSchema } from "@/lib/finance/management-alerts";
import { recruitSettingsSchema } from "@/lib/finance/recruitment";

/**
 * Reporting lines, targets and display settings for the flash report. Everything here needs finance.targets.manage;
 * writes use the service role after the check and are audited.
 */

const PERM = "finance.targets.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => {
  revalidatePath("/finance/flash");
  revalidatePath("/finance/flash/settings");
};

const lineSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => LINE_CODE_RE.test(v) && v !== "CORE" && v !== "UNASSIGNED", {
      message: "Code: 1 to 12 capital letters, digits or _ (not CORE or UNASSIGNED).",
    }),
  label: z.string().trim().min(1, "Give the line a name.").max(60, "Name: at most 60 characters."),
  match_kind: z.enum(["branch", "department"], { message: "Choose branch or department." }),
  match_values: z
    .string()
    .transform((v) =>
      [
        ...new Set(
          v
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x !== ""),
        ),
      ].map((x) => x.slice(0, 80)),
    )
    .refine((v) => v.length >= 1 && v.length <= 20, {
      message: "List 1 to 20 branch codes or department names, separated by commas.",
    }),
  in_core: z.string().optional(),
  active: z.string().optional(),
  sort_order: z.coerce
    .number({ message: "Order must be a number." })
    .int("Order must be a whole number.")
    .min(0)
    .max(10000)
    .default(100),
});

export async function saveReportLine(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = lineSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    org_id: member.orgId,
    code: v.code,
    label: v.label,
    match_kind: v.match_kind,
    match_values: v.match_values,
    in_core: v.in_core === "on",
    active: v.active === "on",
    sort_order: v.sort_order,
    created_by: member.userId,
  };
  const { error } = await admin
    .from("fin_ref_report_lines")
    .upsert(row, { onConflict: "org_id,code" });
  if (error) return fail(dbMessage(error, "Could not save the line."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.flash.line_saved",
    entity: "fin_ref_report_lines",
    entityId: member.orgId,
    diff: {
      code: v.code,
      match_kind: v.match_kind,
      values: v.match_values.length,
      in_core: row.in_core,
      active: row.active,
    },
  });
  refresh();
  return { ok: true, message: `Line ${v.code} saved.` };
}

export async function deleteReportLine(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const code = (values.code ?? "").trim().toUpperCase();
  if (!LINE_CODE_RE.test(code)) return fail("Choose a line.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_report_lines")
    .delete()
    .eq("org_id", member.orgId)
    .eq("code", code);
  if (error) return fail(dbMessage(error, "Could not delete the line."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.flash.line_deleted",
    entity: "fin_ref_report_lines",
    entityId: member.orgId,
    diff: { code },
  });
  refresh();
  return { ok: true, message: `Line ${code} deleted. Its targets are kept but no longer used.` };
}

/**
 * Saves one month's targets. Field names: `rev_<CODE>`, `pat_<CODE>`, `days_<CODE>` (operating days, Q7) per line and
 * `total_rev`, `total_pat`, `total_days`, `total_arpp` for the total. Blank = no target. The month is replaced as a whole (fin_flash_set_targets).
 */
export async function saveTargets(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const month = monthOf(`${(values.month ?? "").slice(0, 7)}-01`);
  if (!month) return fail("Choose a month.");

  type Row = {
    line_code: string | null;
    daily_revenue: number | null;
    daily_patients: number | null;
    arpp: number | null;
    operating_days: number | null;
  };
  const dim = daysInMonth(month);
  const byLine = new Map<string, Row>();
  try {
    for (const [k, raw] of Object.entries(values)) {
      const m = /^(rev|pat|days)_([A-Z0-9_]{1,12})$/.exec(k);
      if (!m) continue;
      const row = byLine.get(m[2]) ?? {
        line_code: m[2],
        daily_revenue: null,
        daily_patients: null,
        arpp: null,
        operating_days: null,
      };
      if (m[1] === "rev") row.daily_revenue = parseTargetInput(raw);
      else if (m[1] === "days") row.operating_days = parseOperatingDays(raw, dim);
      else row.daily_patients = parseTargetInput(raw, 100_000);
      byLine.set(m[2], row);
    }
    if (byLine.size > 60) return fail("Too many lines.");
    const total: Row = {
      line_code: null,
      daily_revenue: parseTargetInput(values.total_rev),
      daily_patients: parseTargetInput(values.total_pat, 100_000),
      arpp: parseTargetInput(values.total_arpp, 1_000_000),
      operating_days: parseOperatingDays(values.total_days, dim),
    };
    const rows = [...byLine.values(), total].filter(
      (r) => r.daily_revenue !== null || r.daily_patients !== null || r.arpp !== null,
    );
    const admin = createAdminClient(member.userId);
    const { data, error } = await admin.rpc("fin_flash_set_targets", {
      p_org_id: member.orgId,
      p_month: month,
      p_rows: rows as unknown as Json,
      p_user: member.userId,
    });
    if (error) return fail(dbMessage(error, "Nothing was saved."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.flash.targets_saved",
      entity: "fin_ref_revenue_targets",
      entityId: member.orgId,
      diff: { month, rows: Number(data ?? rows.length) },
    });
    refresh();
    return { ok: true, message: `Targets for ${month.slice(0, 7)} saved.` };
  } catch (e) {
    return fail(`Nothing was saved. ${e instanceof Error ? e.message : ""}`.trim());
  }
}

/** Copies the previous month's targets into `month` (only when `month` has none yet). */
export async function copyPreviousTargets(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const month = monthOf(`${(values.month ?? "").slice(0, 7)}-01`);
  if (!month) return fail("Choose a month.");
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const previous = d.toISOString().slice(0, 10);
  const admin = createAdminClient(member.userId);
  const [{ data: existing }, { data: prev, error }] = await Promise.all([
    admin
      .from("fin_ref_revenue_targets")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("month", month)
      .limit(1),
    admin
      .from("fin_ref_revenue_targets")
      .select("line_code, daily_revenue, daily_patients, arpp, operating_days")
      .eq("org_id", member.orgId)
      .eq("month", previous),
  ]);
  if (error) return fail(dbMessage(error, "Could not read last month's targets."));
  if ((existing ?? []).length > 0)
    return fail("This month already has targets; edit them instead.");
  if ((prev ?? []).length === 0) return fail("Last month has no targets to copy.");
  const { error: e2 } = await admin.rpc("fin_flash_set_targets", {
    p_org_id: member.orgId,
    p_month: month,
    // a shorter month cannot have more operating days than it has days
    p_rows: (prev ?? []).map((r) => ({
      ...r,
      operating_days:
        r.operating_days === null ? null : Math.min(r.operating_days, daysInMonth(month)),
    })) as unknown as Json,
    p_user: member.userId,
  });
  if (e2) return fail(dbMessage(e2, "Nothing was copied."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.flash.targets_copied",
    entity: "fin_ref_revenue_targets",
    entityId: member.orgId,
    diff: { from: previous, to: month, rows: prev!.length },
  });
  refresh();
  return { ok: true, message: `Copied ${prev!.length} targets from ${previous.slice(0, 7)}.` };
}

/** Doctor performance (Phase 23B): the revenue-per-patient target and the band edges, 0 < moderate < near < target. */
export async function savePerfBands(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = perfSettingsSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the target and bands."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.doctor_performance.bands_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  revalidatePath("/finance/doctor-performance");
  return { ok: true, message: "Target and bands saved." };
}

/** Collections data quality (Phase 23D): an invoice raised more than this many days after the visit is flagged. */
export async function saveDataQualitySettings(
  values: Record<string, string>,
): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = dqSettingsSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the late invoice days."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.collections.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  revalidatePath("/finance/collections");
  return { ok: true, message: "Late invoice days saved." };
}

const displaySchema = z.object({
  flash_share_basis: z.enum(["section", "all"], {
    message: "Choose how doctor shares are worked out.",
  }),
  flash_top_doctors: z.coerce
    .number({ message: "Top doctors must be a number." })
    .int()
    .min(1, "Show at least 1 doctor.")
    .max(50, "Show at most 50 doctors."),
});

export async function saveFlashDisplay(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = displaySchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.flash.display_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  return { ok: true, message: "Saved." };
}

/** Insurance billed vs claimed (Phase 23D-2): the difference tolerance (AED) and the grace days before "at risk". */
export async function saveInsuranceRecon(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = reconSettingsSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the tolerance and grace days."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.insurance_billing.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  revalidatePath("/finance/insurance-billing");
  return { ok: true, message: "Tolerance and grace days saved." };
}

/** Management alerts (M1): report late, revenue behind target and the revenue-per-patient band (thresholds only). */
export async function saveMgmtAlertSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = mgmtAlertSettingsSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the alert settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.management_alerts.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  revalidatePath("/finance/flash/settings");
  return { ok: true, message: "Alert settings saved." };
}

/** The recruitment calculator's defaults are cost assumptions: finance.costs.manage, not the targets key. */
async function gateRecruit() {
  const member = await requireMember();
  return can(member, "finance.costs.manage") ? member : null;
}

/** Recruitment calculator (M4): conservative factor, consumables %, gateway %, minimum peer doctor-months. */
export async function saveRecruitDefaults(values: Record<string, string>): Promise<ActionResult> {
  const member = await gateRecruit();
  if (!member) return fail(DENIED);
  const parsed = recruitSettingsSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the recruitment defaults."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recruitment.defaults_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  revalidatePath("/finance/flash/settings");
  revalidatePath("/finance/recruitment");
  return { ok: true, message: "Recruitment defaults saved." };
}
