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
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  AMOUNT_STYLES,
  DATE_FORMATS,
  IMPORT_KINDS,
  isImportKind,
  validateMapping,
  type AmountStyle,
} from "@/lib/finance/import-kinds";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Bank accounts, file layouts, settlement rules and matching thresholds. Everything here needs finance.bank.manage;
 * writes use the service role after the check and are audited.
 */

const PERM = "finance.bank.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => {
  revalidatePath("/finance/bank");
  revalidatePath("/finance/bank/settings");
};

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || uuid.safeParse(v).success, "Invalid record.");

const accountSchema = z.object({
  id: optionalId,
  name: z.string().trim().min(1, "Give the account a name.").max(60),
  bank_name: z.string().trim().min(1, "Give the bank's name.").max(60),
  last4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Enter the last 4 digits of the account number only."),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{3}$/.test(v), "Currency: a 3-letter code such as AED."),
  ledger_name: z.string().trim().max(100).optional().default(""),
  receives_insurance: z.string().optional(),
  active: z.string().optional(),
});

export async function saveAccount(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = accountSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    name: v.name,
    bank_name: v.bank_name,
    last4: v.last4,
    currency: v.currency,
    ledger_name: v.ledger_name || null,
    receives_insurance: v.receives_insurance === "on",
    active: v.active === "on",
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_bank_accounts")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .select("id")
    : await admin
        .from("fin_bank_accounts")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error || !data?.length)
    return fail(
      error?.code === "23505"
        ? "An account with that name exists, or another account already receives insurance payments."
        : dbMessage(error, "Could not save the account."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.bank.account_updated" : "finance.bank.account_added",
    entity: "fin_bank_accounts",
    entityId: data[0].id,
    diff: { receives_insurance: row.receives_insurance, active: row.active },
  });
  refresh();
  return { ok: true, message: "Account saved." };
}

const formatSchema = z.object({
  id: optionalId,
  kind: z.string().refine(isImportKind, "Choose the kind of file."),
  name: z.string().trim().min(1, "Give the layout a name.").max(60),
  date_format: z.enum(DATE_FORMATS, { message: "Choose the date format." }),
  amount_style: z.enum(AMOUNT_STYLES).default("signed"),
  active: z.string().optional(),
});

/** Saves a file layout. Field names are `col_<field>` (the header text in the file for that field). */
export async function saveFormat(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = formatSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const kind = v.kind as keyof typeof IMPORT_KINDS;
  const style: AmountStyle = IMPORT_KINDS[kind].usesAmountStyle ? v.amount_style : "signed";
  const raw = Object.fromEntries(
    Object.entries(values)
      .filter(([k]) => k.startsWith("col_"))
      .map(([k, val]) => [k.slice(4), val]),
  );
  const mapping = validateMapping(kind, style, raw);
  if (!mapping.ok) return fail(mapping.error);
  const admin = createAdminClient(member.userId);
  const row = {
    kind,
    name: v.name,
    mapping: mapping.mapping,
    date_format: v.date_format,
    amount_style: style,
    active: v.active === "on",
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_import_formats")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .select("id")
    : await admin
        .from("fin_import_formats")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not save the layout."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.bank.format_updated" : "finance.bank.format_added",
    entity: "fin_import_formats",
    entityId: data[0].id,
    diff: {
      kind,
      fields: Object.keys(mapping.mapping),
      date_format: v.date_format,
      amount_style: style,
    },
  });
  refresh();
  return { ok: true, message: "Layout saved." };
}

const ruleSchema = z.object({
  id: optionalId,
  payment_mode: z
    .string()
    .trim()
    .min(1, "Enter the payment mode exactly as Unite shows it.")
    .max(60),
  lag_days: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 30),
      "Lag: 0 to 30 working days, or blank.",
    ),
  fee_pct: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v.replace("%", ""))))
    .refine(
      (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 20),
      "Fee: 0 to 20 %, or blank.",
    ),
  account_id: optionalId,
  source: z.enum(["collections", "settlement"]).default("collections"),
  settles_to_bank: z.string().optional(),
});

export async function saveRule(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = ruleSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const row = {
    payment_mode: v.payment_mode,
    lag_days: v.lag_days,
    fee_pct: v.fee_pct,
    account_id: v.account_id,
    source: v.source,
    settles_to_bank: v.settles_to_bank === "on",
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_ref_settlement_rules")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .select("id")
    : await admin
        .from("fin_ref_settlement_rules")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error || !data?.length)
    return fail(
      error?.code === "23505"
        ? "There is already a rule for that payment mode."
        : dbMessage(error, "Could not save the rule."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.rule_saved",
    entity: "fin_ref_settlement_rules",
    entityId: data[0].id,
    diff: { ...row },
  });
  refresh();
  return { ok: true, message: `Rule for ${v.payment_mode} saved.` };
}

export async function deleteRule(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(values.id);
  if (!id.success) return fail("Choose a rule.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_settlement_rules")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id.data)
    .select("payment_mode");
  if (error || !data?.length) return fail(dbMessage(error, "Could not delete the rule."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.rule_deleted",
    entity: "fin_ref_settlement_rules",
    entityId: id.data,
    diff: { payment_mode: data[0].payment_mode },
  });
  refresh();
  return { ok: true, message: "Rule deleted." };
}

/** Adds the starter rules (card, EPG, Tabby, cash, rePG, MX, insurance credit) that are missing; never overwrites. */
export async function addStarterRules(): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_seed_settlement_rules", { p_org_id: member.orgId });
  if (error) return fail(dbMessage(error, "Could not add the starter rules."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.rules_seeded",
    entity: "fin_ref_settlement_rules",
    entityId: member.orgId,
  });
  refresh();
  return { ok: true, message: "Starter rules added where missing." };
}

const settingsSchema = z.object({
  bank_date_window_days: z.coerce
    .number()
    .int()
    .min(0, "Window: 0 to 10 days.")
    .max(10, "Window: 0 to 10 days."),
  bank_amount_tolerance: z.coerce
    .number()
    .min(0, "Tolerance: 0 to 1,000.")
    .max(1000, "Tolerance: 0 to 1,000."),
  bank_amount_tolerance_pct: z.coerce
    .number()
    .min(0, "Tolerance %: 0 to 5.")
    .max(5, "Tolerance %: 0 to 5."),
  bank_auto_accept_score: z.coerce
    .number()
    .int()
    .min(50, "Auto-accept: 50 to 100.")
    .max(100, "Auto-accept: 50 to 100."),
  bank_cutoff_day: z.coerce
    .number()
    .int()
    .min(1, "Cut-off: day 1 to 31.")
    .max(31, "Cut-off: day 1 to 31."),
});

/** Matching thresholds and the calendar. Weekend days come as `wd_0` ... `wd_6` checkboxes. */
export async function saveBankSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = settingsSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const weekend = [0, 1, 2, 3, 4, 5, 6].filter((d) => values[`wd_${d}`] === "on");
  if (weekend.length > 3) return fail("Choose at most 3 weekend days.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert(
      { org_id: member.orgId, ...p.data, bank_weekend_days: weekend },
      { onConflict: "org_id" },
    );
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: { ...p.data, bank_weekend_days: weekend },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}
