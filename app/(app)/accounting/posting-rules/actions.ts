"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { POSTING_SOURCES, RULE_KIND_LIST } from "@/lib/accounting/posting/types";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  optionalText,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Posting rules and posting settings (Phase 22D), accounting.settings.manage. Rules are data (acc_posting_rules); the
 * database trigger normalises keys and checks the account and tax code belong to the org. Every change is audited (ids,
 * kinds and codes only).
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const MANAGE = "accounting.settings.manage";

const ruleSchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  kind: z.enum(RULE_KIND_LIST),
  key: z.string().trim().max(80, "Keep the key under 80 characters.").default("*"),
  qualifier: z.string().trim().max(80, "Keep the qualifier under 80 characters.").default("*"),
  account_id: z.union([uuid, z.literal("")]).default(""),
  tax_code_id: z.union([uuid, z.literal("")]).default(""),
  note: optionalText(200),
  active: z.string().optional(),
});

function refresh() {
  revalidatePath("/accounting/posting-rules");
  revalidatePath("/accounting/waiting");
}

export async function savePostingRule(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = ruleSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (v.kind === "service_tax" && !v.tax_code_id) return fail("Choose the VAT code.");
  if (v.kind !== "service_tax" && !v.account_id) return fail("Choose the account.");
  if (v.tax_code_id && !["service_tax", "expense", "bank_charges"].includes(v.kind))
    return fail("Only VAT per service category, expenses and bank charges take a tax code.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    kind: v.kind,
    key: v.key || "*",
    qualifier: v.qualifier || "*",
    account_id: v.kind === "service_tax" ? null : v.account_id,
    tax_code_id: v.tax_code_id || null,
    note: v.note,
    active: v.id ? v.active === "on" : true,
    origin: "manual",
    updated_by: member.userId,
  };
  const { data, error } = v.id
    ? await admin
        .from("acc_posting_rules")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_posting_rules")
        .insert({ ...row, org_id: member.orgId })
        .select("id")
        .single();
  if (error || !data)
    return fail(
      error?.code === "23505"
        ? "A rule for this kind, key and qualifier already exists; edit that one."
        : rpcErrorMessage(error, "The rule could not be saved."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.posting_rule.updated" : "accounting.posting_rule.created",
    entity: "acc_posting_rules",
    entityId: data.id,
    diff: {
      kind: row.kind,
      key: row.key,
      qualifier: row.qualifier,
      account_id: row.account_id,
      tax_code_id: row.tax_code_id,
      active: row.active,
    },
  });
  refresh();
  return { ok: true, message: "Rule saved. Waiting items are tried again on the next run." };
}

export async function deletePostingRule(id: string): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("acc_posting_rules")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id, kind, key, qualifier");
  if (error || !data?.length) return fail(rpcErrorMessage(error, "The rule could not be removed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.posting_rule.deleted",
    entity: "acc_posting_rules",
    entityId: id,
    diff: { kind: data[0].kind, key: data[0].key, qualifier: data[0].qualifier },
  });
  refresh();
  return { ok: true, message: "Rule removed." };
}

const settingsSchema = z.object({
  denial_allowance_enabled: z.string().optional(),
  package_invoices: z.enum(["hold", "post"]),
  rounding_tolerance: z.coerce.number().min(0).max(100),
  vat_tolerance: z.coerce.number().min(0).max(10),
  paused: z.string().optional(),
});

export async function savePostingSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = settingsSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const paused = POSTING_SOURCES.filter((s) => values[`pause_${s}`] === "on");
  const admin = createAdminClient(member.userId);
  const row = {
    org_id: member.orgId,
    denial_allowance_enabled: p.data.denial_allowance_enabled === "on",
    package_invoices: p.data.package_invoices,
    rounding_tolerance: p.data.rounding_tolerance,
    vat_tolerance: p.data.vat_tolerance,
    paused_sources: paused,
    updated_by: member.userId,
  };
  const { error } = await admin.from("acc_posting_settings").upsert(row, { onConflict: "org_id" });
  if (error) return fail(rpcErrorMessage(error, "The settings could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.posting_settings.updated",
    entity: "acc_posting_settings",
    diff: {
      denial_allowance_enabled: row.denial_allowance_enabled,
      package_invoices: row.package_invoices,
      rounding_tolerance: row.rounding_tolerance,
      vat_tolerance: row.vat_tolerance,
      paused_sources: paused,
    },
  });
  refresh();
  return { ok: true, message: "Posting settings saved." };
}

/** Adds the default rules that are missing (never changes an existing rule). */
export async function seedPostingRules(): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_seed_posting_rules", { p_org_id: member.orgId });
  if (error) return fail(rpcErrorMessage(error, "The default rules could not be added."));
  const r = (data ?? {}) as { rules_added?: number; accounts_added?: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.posting_rules.seeded",
    entity: "acc_posting_rules",
    diff: { rules_added: r.rules_added ?? 0, accounts_added: r.accounts_added ?? 0 },
  });
  refresh();
  return {
    ok: true,
    message: `${r.rules_added ?? 0} default rule(s) added${r.accounts_added ? `, ${r.accounts_added} ledger(s)` : ""}.`,
  };
}
