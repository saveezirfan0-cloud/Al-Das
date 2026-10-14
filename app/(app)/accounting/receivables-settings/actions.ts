"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/** Sales settings (Phase 22E), accounting.settings.manage: the approval limit, prefixes and the seller block. Audited. */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const prefix = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => /^[A-Z]{1,6}$/.test(v), "A prefix is 1 to 6 letters.");

const schema = z
  .object({
    issue_approval_threshold: z.coerce.number().min(0).max(1e11),
    simplified_invoice_limit: z.coerce.number().min(0).max(10000, "The FTA limit is AED 10,000."),
    credit_note_days: z.coerce.number().int().min(1).max(365),
    invoice_prefix: prefix,
    credit_note_prefix: prefix,
    receipt_prefix: prefix,
    seller_address: z.string().trim().max(300).default(""),
    payment_instructions: z.string().trim().max(500).default(""),
  })
  .refine(
    (v) => new Set([v.invoice_prefix, v.credit_note_prefix, v.receipt_prefix]).size === 3,
    "Use three different prefixes.",
  );

export async function saveArSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.settings.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { error } = await admin.from("acc_ar_settings").upsert(
    {
      org_id: member.orgId,
      issue_approval_threshold: Math.round(v.issue_approval_threshold * 100) / 100,
      simplified_invoice_limit: Math.round(v.simplified_invoice_limit * 100) / 100,
      credit_note_days: v.credit_note_days,
      invoice_prefix: v.invoice_prefix,
      credit_note_prefix: v.credit_note_prefix,
      receipt_prefix: v.receipt_prefix,
      seller_address: v.seller_address || null,
      payment_instructions: v.payment_instructions || null,
      updated_by: member.userId,
    },
    { onConflict: "org_id" },
  );
  if (error) return fail(rpcErrorMessage(error, "The settings could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_settings.updated",
    entity: "acc_ar_settings",
    entityId: member.orgId,
    diff: {
      issue_approval_threshold: v.issue_approval_threshold,
      simplified_invoice_limit: v.simplified_invoice_limit,
      credit_note_days: v.credit_note_days,
      prefixes: [v.invoice_prefix, v.credit_note_prefix, v.receipt_prefix].join("/"),
    },
  });
  revalidatePath("/accounting/receivables-settings");
  return { ok: true, message: "Settings saved. New prefixes apply from the next new fiscal year's series." };
}
