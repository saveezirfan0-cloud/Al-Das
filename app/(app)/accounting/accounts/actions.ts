"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ACCOUNT_CODE_RE, CONTROL_KINDS } from "@/lib/accounting/accounts";
import { rpcErrorMessage } from "@/lib/accounting/errors";
import { CASH_FLOW_CLASSES } from "@/lib/accounting/statements/cash-flow";
import { CT_TREATMENTS } from "@/lib/accounting/statements/corporate-tax";
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
 * The chart of accounts (Phase 22A), accounting.coa.manage. The database guard (acc_account_guard) keeps the tree sound:
 * parents are groups of the same nature, Tally's predefined groups keep their place, an account with lines keeps its
 * nature and is deactivated instead of deleted. Every change is audited and kept in the record history.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const accountSchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  parent_id: z.union([uuid, z.literal("")]).default(""),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(
      (v) => ACCOUNT_CODE_RE.test(v),
      "Codes use letters, digits, dot, dash or underscore (up to 20).",
    ),
  name: z.string().trim().min(1, "Enter a name.").max(120),
  is_group: z.string().optional(),
  control: z.union([z.enum(CONTROL_KINDS), z.literal("")]).default(""),
  allow_manual: z.string().optional(),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z]{3}$/.test(v), "Currency is a three-letter code.")
    .default(""),
  description: optionalText(300),
  system: z.string().optional(),
});

export async function saveAccount(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = accountSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const isGroup = v.is_group === "on";
  let row: {
    name: string;
    description: string | null;
    parent_id?: string;
    code?: string;
    nature?: string;
    is_group?: boolean;
    control?: string | null;
    allow_manual?: boolean;
    currency?: string | null;
  };
  if (v.system === "1") {
    // a system group: only its name and description are editable (the database refuses anything else)
    row = { name: v.name, description: v.description };
  } else {
    if (!v.parent_id) return fail("Choose the group it belongs to.");
    const { data: parent } = await admin
      .from("acc_accounts")
      .select("nature, is_group")
      .eq("id", v.parent_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!parent?.is_group) return fail("Choose a group as the parent.");
    row = {
      parent_id: v.parent_id,
      code: v.code,
      name: v.name,
      nature: parent.nature, // an account has its group's nature (the database checks it again)
      is_group: isGroup,
      control: isGroup ? null : v.control || null,
      allow_manual: isGroup ? true : v.allow_manual === "on",
      currency: isGroup ? null : v.currency || null,
      description: v.description,
    };
  }
  const { data, error } = v.id
    ? await admin
        .from("acc_accounts")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_accounts")
        .insert({
          ...row,
          code: v.code,
          nature: row.nature ?? "asset",
          org_id: member.orgId,
          created_by: member.userId,
        })
        .select("id")
        .single();
  if (error || !data) return fail(rpcErrorMessage(error, "The account could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.account.updated" : "accounting.account.created",
    entity: "acc_accounts",
    entityId: data.id,
    diff: { code: v.code, group: isGroup, control: v.control || null },
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, data: { id: data.id }, message: "Account saved." };
}

const toggleSchema = z.object({ id: uuid, active: z.boolean() });

export async function setAccountActive(raw: z.input<typeof toggleSchema>): Promise<ActionResult> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = toggleSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("acc_accounts")
    .update({ is_active: p.data.active })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId);
  if (error) return fail(rpcErrorMessage(error, "The account could not be changed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: p.data.active ? "accounting.account.activated" : "accounting.account.deactivated",
    entity: "acc_accounts",
    entityId: p.data.id,
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, message: p.data.active ? "Account activated." : "Account deactivated." };
}

export async function deleteAccount(raw: { id: string }): Promise<ActionResult> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = z.object({ id: uuid }).safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error, count } = await admin
    .from("acc_accounts")
    .delete({ count: "exact" })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId);
  if (error) return fail(rpcErrorMessage(error, "The account could not be deleted."));
  if (!count) return fail("Account not found.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.account.deleted",
    entity: "acc_accounts",
    entityId: p.data.id,
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, message: "Account deleted." };
}

const reportingSchema = z.object({
  id: uuid,
  cash_flow_class: z.union([z.enum(CASH_FLOW_CLASSES), z.literal("")]).default(""),
  ct_treatment: z.union([z.enum(CT_TREATMENTS), z.literal("")]).default(""),
  requires_branch: z.string().optional(),
  requires_cost_centre: z.string().optional(),
});

/**
 * How an account is reported (Phase 22G): its cash flow class (blank = from its group), the corporate tax treatment
 * and whether its lines should carry a branch or cost centre (the exception report lists those that do not; posting is
 * unchanged). Groups take a cash flow class only.
 */
export async function saveAccountReporting(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = reportingSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data: acc } = await admin
    .from("acc_accounts")
    .select("id, is_group, nature")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!acc) return fail("Account not found.");
  const pl = acc.nature === "income" || acc.nature === "expense";
  const row = {
    cash_flow_class: pl ? null : p.data.cash_flow_class || null,
    ct_treatment: acc.is_group || acc.nature !== "expense" ? null : p.data.ct_treatment || null,
    requires_branch: !acc.is_group && p.data.requires_branch === "on",
    requires_cost_centre: !acc.is_group && p.data.requires_cost_centre === "on",
  };
  const { error } = await admin
    .from("acc_accounts")
    .update(row)
    .eq("id", acc.id)
    .eq("org_id", member.orgId);
  if (error) return fail(rpcErrorMessage(error, "The account could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.account.reporting_updated",
    entity: "acc_accounts",
    entityId: acc.id,
    diff: row,
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, message: "Reporting saved." };
}
