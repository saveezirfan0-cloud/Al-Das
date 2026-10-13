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
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Voucher settings. The delegation of authority (tiers, special categories, approval mode, report thresholds) needs
 * finance.vouchers.settings (the Finance Manager preset and Admin: the maker never edits the rules that route their own
 * vouchers). Tally ledger mapping and the Tally company need finance.tally.export. Everything is audited; a tier change
 * applies to vouchers submitted afterwards (a submitted voucher keeps the route it was given).
 */

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}

function refresh() {
  revalidatePath("/finance/vouchers/settings");
  revalidatePath("/finance/vouchers");
  revalidatePath("/finance/tally");
}

const money = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v.replace(/,/g, ""))))
    .refine(
      (v) => v === null || (Number.isFinite(v) && v >= 0 && v < 1e11),
      `${label}: enter an amount.`,
    )
    .transform((v) => (v === null ? null : Math.round(v * 100) / 100));

const tierSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_]{1,12}$/, "Code: 1 to 12 capital letters, digits or _."),
    label: z.string().trim().min(1, "Give the rule a name.").max(60),
    special_category: z.enum(["", "payroll", "intercompany", "related_party"]).default(""),
    min_amount: money("From"),
    max_amount: money("Up to"),
    needs_dept_head: z.string().optional(),
    needs_ceo: z.string().optional(),
    bulk_allowed: z.string().optional(),
    active: z.string().optional(),
    description: z.string().trim().max(300).default(""),
    sort_order: z.coerce.number().int().min(0).max(10000).default(100),
  })
  .refine((v) => (v.special_category === "") === (v.min_amount !== null), {
    message: "An amount band needs a 'from' amount; a special category has no amounts.",
  })
  .refine((v) => v.special_category === "" || v.max_amount === null, {
    message: "A special category applies at any amount: leave 'up to' blank.",
  })
  .refine((v) => v.max_amount === null || v.min_amount === null || v.max_amount >= v.min_amount, {
    message: "'Up to' must not be below 'from'.",
  })
  .refine(
    (v) =>
      v.bulk_allowed !== "on" ||
      (v.needs_dept_head !== "on" && v.needs_ceo !== "on" && v.special_category === ""),
    {
      message:
        "Bulk verification is only for routine amounts that need no approval beyond the Finance Manager.",
    },
  );

export async function saveTier(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.vouchers.settings");
  if (!member) return fail(DENIED);
  const p = tierSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    org_id: member.orgId,
    code: v.code,
    label: v.label,
    special_category: v.special_category || null,
    min_amount: v.min_amount,
    max_amount: v.max_amount,
    needs_dept_head: v.needs_dept_head === "on",
    needs_ceo: v.needs_ceo === "on",
    bulk_allowed: v.bulk_allowed === "on",
    active: v.active === "on",
    description: v.description || null,
    sort_order: v.sort_order,
    updated_by: member.userId,
  };
  const { error } = await admin
    .from("fin_ref_approval_tiers")
    .upsert(row, { onConflict: "org_id,code" });
  if (error)
    return fail(
      dbMessage(error, "Could not save the rule (a special category can have only one rule)."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.vouchers.tier_saved",
    entity: "fin_ref_approval_tiers",
    entityId: member.orgId,
    diff: {
      code: row.code,
      special: row.special_category,
      min: row.min_amount,
      max: row.max_amount,
      dept: row.needs_dept_head,
      ceo: row.needs_ceo,
      bulk: row.bulk_allowed,
      active: row.active,
    },
  });
  refresh();
  return {
    ok: true,
    message: `Rule ${v.code} saved. It applies to vouchers submitted from now on.`,
  };
}

const modeSchema = z.object({
  approval_mode: z.enum(["pulse", "tally"], { message: "Choose where vouchers are approved." }),
  confirm: z.string().default(""),
  voucher_duplicate_window_days: z.coerce.number().int().min(0).max(365),
  voucher_mismatch_tolerance: z.coerce.number().min(0).max(1_000_000),
  voucher_large_amount: z.coerce.number().gt(0).max(1e11),
});

export async function saveApprovalSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.vouchers.settings");
  if (!member) return fail(DENIED);
  const p = modeSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("fin_ref_finance_settings")
    .select("approval_mode")
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (
    current?.approval_mode !== v.approval_mode &&
    v.confirm.trim().toUpperCase() !== v.approval_mode.toUpperCase()
  )
    return fail(`Type ${v.approval_mode.toUpperCase()} to confirm the change of approval mode.`);
  const { error } = await admin.from("fin_ref_finance_settings").upsert(
    {
      org_id: member.orgId,
      approval_mode: v.approval_mode,
      voucher_duplicate_window_days: v.voucher_duplicate_window_days,
      voucher_mismatch_tolerance: Math.round(v.voucher_mismatch_tolerance * 100) / 100,
      voucher_large_amount: Math.round(v.voucher_large_amount * 100) / 100,
    },
    { onConflict: "org_id" },
  );
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.vouchers.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: {
      approval_mode: v.approval_mode,
      mode_changed: current?.approval_mode !== v.approval_mode,
      duplicate_window_days: v.voucher_duplicate_window_days,
      mismatch_tolerance: v.voucher_mismatch_tolerance,
      large_amount: v.voucher_large_amount,
    },
  });
  refresh();
  return { ok: true, message: "Saved." };
}

const ledgerSchema = z.object({
  kind: z.enum(["supplier", "category", "bank", "cost_centre", "vat_input"], {
    message: "Choose what to map.",
  }),
  key: z.string().trim().min(1, "Enter the Pulse value to map.").max(80),
  ledger_name: z
    .string()
    .trim()
    .min(1, "Enter the Tally ledger name exactly as in Tally.")
    .max(120),
});

export async function saveLedger(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.tally.export");
  if (!member) return fail(DENIED);
  const p = ledgerSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = { ...p.data, key: p.data.kind === "vat_input" ? "*" : p.data.key };
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_tally_ledgers")
    .upsert(
      { org_id: member.orgId, ...v, updated_by: member.userId },
      { onConflict: "org_id,kind,key" },
    );
  if (error) return fail(dbMessage(error, "Could not save the mapping."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.tally.ledger_saved",
    entity: "fin_ref_tally_ledgers",
    entityId: member.orgId,
    diff: v,
  });
  refresh();
  return { ok: true, message: "Mapping saved." };
}

export async function deleteLedger(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.tally.export");
  if (!member) return fail(DENIED);
  const p = ledgerSchema.pick({ kind: true, key: true }).safeParse(values);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_tally_ledgers")
    .delete()
    .eq("org_id", member.orgId)
    .eq("kind", p.data.kind)
    .eq("key", p.data.key);
  if (error) return fail(dbMessage(error, "Could not delete the mapping."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.tally.ledger_deleted",
    entity: "fin_ref_tally_ledgers",
    entityId: member.orgId,
    diff: p.data,
  });
  refresh();
  return { ok: true, message: "Mapping deleted." };
}

const tallySchema = z.object({
  tally_company_name: z.string().trim().max(120).default(""),
  tally_cost_category: z.string().trim().min(1, "Enter the cost category name.").max(120),
});

export async function saveTallySettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.tally.export");
  if (!member) return fail(DENIED);
  const p = tallySchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin.from("fin_ref_finance_settings").upsert(
    {
      org_id: member.orgId,
      tally_company_name: p.data.tally_company_name || null,
      tally_cost_category: p.data.tally_cost_category,
    },
    { onConflict: "org_id" },
  );
  if (error) return fail(dbMessage(error, "Could not save the Tally settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.tally.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: { company_set: !!p.data.tally_company_name, cost_category: p.data.tally_cost_category },
  });
  refresh();
  return { ok: true, message: "Saved." };
}
