"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  optionalText,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  PAYMENT_METHODS,
  SPECIAL_CATEGORIES,
  voucherErrorMessage,
  type VoucherAction,
} from "@/lib/finance/vouchers";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Payment vouchers (Phase 20D). Each step checks its own permission here, then the database (fin_voucher_act, service
 * role only) enforces the order, a different person at every step, mandatory rejection remarks, the content hash the
 * person was looking at, the delegation of authority and the month lock. Every step is audited and lands in the voucher's
 * append-only trail; the next people are told through notify() with a fixed generic sentence and ids only.
 */

const PREPARE = ["finance.vouchers.prepare"] as const;

/** The permission(s) that may attempt each step; the database decides the exact one for a rejection. */
const STEP_PERMS: Record<VoucherAction, readonly string[]> = {
  submit: ["finance.vouchers.prepare"],
  reopen: ["finance.vouchers.prepare"],
  cancel: ["finance.vouchers.prepare"],
  check: ["finance.vouchers.check"],
  approve_dept: ["finance.vouchers.approve_dept"],
  approve_ceo: ["finance.vouchers.approve_ceo"],
  reject: [
    "finance.vouchers.check",
    "finance.vouchers.approve_dept",
    "finance.vouchers.approve_ceo",
  ],
  pay: ["finance.vouchers.pay"],
};

async function gate(perms: readonly string[]) {
  const member = await requireMember();
  return canAny(member, perms) ? member : null;
}

function refresh() {
  revalidatePath("/finance/vouchers");
  revalidatePath("/finance/vouchers/report");
  revalidatePath("/finance/payables");
  revalidatePath("/finance/tally");
}

const uuidList = z
  .string()
  .default("")
  .transform((v) => [
    ...new Set(
      v
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ])
  .refine(
    (ids) => ids.length <= 50 && ids.every((x) => uuid.safeParse(x).success),
    "Reload the page and try again.",
  );

const voucherSchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  voucher_date: isoDate,
  payee_name: z.string().trim().min(1, "Enter the payee.").max(120),
  supplier_id: z.union([uuid, z.literal("")]).default(""),
  amount: z
    .string()
    .trim()
    .transform((v) => Number(v.replace(/,/g, "")))
    .refine((v) => Number.isFinite(v) && v > 0 && v < 1e11, "Enter an amount above zero.")
    .refine(
      (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6,
      "Amounts have at most two decimals.",
    )
    .transform((v) => Math.round(v * 100) / 100),
  category: z.string().trim().min(1, "Choose or type a category.").max(60),
  special_category: z.enum(SPECIAL_CATEGORIES).default("none"),
  branch_code: optionalText(20),
  cost_centre: optionalText(40),
  pay_from: optionalText(40),
  payment_method: z.enum(PAYMENT_METHODS).default("bank_transfer"),
  narration: z.string().trim().min(1, "Say what the payment is for.").max(500),
  invoice_ids: uuidList,
  document_ids: uuidList,
});

export async function saveVoucher(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string; voucherNo: string }>> {
  const member = await gate(PREPARE);
  if (!member) return fail(DENIED);
  const p = voucherSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("fin_voucher_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_voucher_id: (v.id || null) as string,
    p_fields: {
      voucher_date: v.voucher_date,
      payee_name: v.payee_name,
      supplier_id: v.supplier_id,
      amount: v.amount,
      category: v.category,
      special_category: v.special_category,
      branch_code: v.branch_code,
      cost_centre: v.cost_centre,
      pay_from: v.pay_from,
      payment_method: v.payment_method,
      narration: v.narration,
    } as Json,
    p_invoice_ids: v.invoice_ids,
    p_document_ids: v.document_ids,
  });
  if (error || !data) return fail(rpcError(error, "The voucher could not be saved."));
  const r = data as { id: string; voucher_no: string; returned_to_draft: boolean };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.voucher.updated" : "finance.voucher.created",
    entity: "fin_payment_vouchers",
    entityId: r.id,
    diff: {
      voucher_no: r.voucher_no,
      amount: v.amount,
      special: v.special_category,
      invoices: v.invoice_ids.length,
      documents: v.document_ids.length,
      returned_to_draft: r.returned_to_draft,
    },
  });
  refresh();
  return {
    ok: true,
    data: { id: r.id, voucherNo: r.voucher_no },
    message: r.returned_to_draft
      ? `${r.voucher_no} saved and returned to draft; its approvals were cleared. Submit it again.`
      : `${r.voucher_no} saved as a draft.`,
  };
}

function rpcError(err: { code?: string; hint?: string | null } | null, fallback: string): string {
  if (err?.code === "42501") return voucherErrorMessage("month_locked", fallback);
  if (err?.code === "23505") return "That already exists.";
  return voucherErrorMessage(err?.hint, fallback);
}

const stepSchema = z.object({
  id: uuid,
  action: z.enum([
    "submit",
    "check",
    "approve_dept",
    "approve_ceo",
    "reject",
    "reopen",
    "cancel",
    "pay",
  ]),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullish(),
  remarks: z.string().trim().max(1000).default(""),
  payment_date: z.string().trim().default(""),
  payment_reference: z.string().trim().max(60).default(""),
});

const DONE: Record<VoucherAction, string> = {
  submit: "Submitted. The Finance Manager verifies it next.",
  check: "Verified.",
  approve_dept: "Approved for the department.",
  approve_ceo: "Authorised.",
  reject: "Rejected and sent back to the maker with your remarks.",
  reopen: "Reopened as a draft.",
  cancel: "Cancelled.",
  pay: "Payment recorded.",
};

type StepResult = {
  id: string;
  voucher_no: string;
  from: string;
  to: string;
  needs_dept: boolean;
  needs_ceo: boolean;
  prepared_by: string | null;
  submitted_by: string | null;
};

/** One step of the approval chain. */
export async function voucherStep(
  raw: z.input<typeof stepSchema>,
): Promise<ActionResult<{ status: string }>> {
  const parsed = stepSchema.safeParse(raw);
  if (!parsed.success) return fail("Reload the page and try again.");
  const s = parsed.data;
  const member = await gate(STEP_PERMS[s.action]);
  if (!member) return fail(DENIED);
  if (s.action === "pay" && !isoDate.safeParse(s.payment_date).success)
    return fail(voucherErrorMessage("payment_details_required", "Enter the payment date."));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_voucher_act", {
    p_org_id: member.orgId,
    p_voucher_id: s.id,
    p_user_id: member.userId,
    p_action: s.action,
    p_hash: (s.hash ?? null) as string,
    p_remarks: s.remarks,
    p_payment: (s.action === "pay"
      ? { date: s.payment_date, reference: s.payment_reference }
      : null) as Json,
  });
  if (error || !data) return fail(rpcError(error, "That step could not be saved."));
  const r = data as StepResult;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `finance.voucher.${s.action}`,
    entity: "fin_payment_vouchers",
    entityId: r.id,
    diff: { voucher_no: r.voucher_no, from: r.from, to: r.to, remarks: s.remarks !== "" },
  });
  await tellNext(admin, member.orgId, member.userId, r);
  refresh();
  return { ok: true, data: { status: r.to }, message: DONE[s.action] };
}

/** Who acts next is told (fixed generic sentence, ids only). */
async function tellNext(admin: AdminClient, orgId: string, actorId: string, r: StepResult) {
  const base = { orgId, payload: { voucher_id: r.id } as NonNullable<Json>, exceptUserId: actorId };
  if (r.to === "submitted")
    await notify(admin, {
      ...base,
      userIds: await memberIdsWithPermission(admin, orgId, "finance.vouchers.check"),
      event: "finance.voucher_to_check",
      type: "finance.voucher_to_check",
      title: `Payment voucher ${r.voucher_no} is waiting for verification`,
      body: "Open Finance, Vouchers.",
    });
  else if (r.to === "checked" && r.needs_dept)
    await notify(admin, {
      ...base,
      userIds: await memberIdsWithPermission(admin, orgId, "finance.vouchers.approve_dept"),
      event: "finance.voucher_to_approve_dept",
      type: "finance.voucher_to_approve_dept",
      title: `Payment voucher ${r.voucher_no} needs a department head`,
      body: "Open Finance, Vouchers.",
    });
  else if ((r.to === "checked" && !r.needs_dept && r.needs_ceo) || r.to === "dept_approved")
    await notify(admin, {
      ...base,
      userIds: await memberIdsWithPermission(admin, orgId, "finance.vouchers.approve_ceo"),
      event: "finance.voucher_to_approve",
      type: "finance.voucher_to_approve",
      title: `Payment voucher ${r.voucher_no} needs your authorisation`,
      body: "Open Finance, Vouchers.",
    });
  else if (r.to === "rejected")
    await notify(admin, {
      ...base,
      userIds: [r.prepared_by, r.submitted_by].filter((x): x is string => !!x),
      event: "finance.voucher_rejected",
      type: "finance.voucher_rejected",
      title: `Payment voucher ${r.voucher_no} was rejected`,
      body: "Open it to read the remarks.",
    });
}

const bulkSchema = z.object({
  items: z
    .array(z.object({ id: uuid, hash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1, "Choose at least one voucher.")
    .max(200, "Choose at most 200 vouchers."),
  remarks: z.string().trim().max(1000).default(""),
});

/** Bulk verification of routine (Tier 1) vouchers; each one is bound to the hash shown and succeeds or fails alone. */
export async function bulkCheckVouchers(
  raw: z.input<typeof bulkSchema>,
): Promise<ActionResult<{ done: number; failed: number }>> {
  const member = await gate(["finance.vouchers.check"]);
  if (!member) return fail(DENIED);
  const p = bulkSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_voucher_bulk_check", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_items: p.data.items as unknown as Json,
    p_remarks: p.data.remarks,
  });
  if (error || !data) return fail(rpcError(error, "Nothing was verified."));
  const r = data as { done: string[]; failed: Array<{ id: string; code: string }> };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.voucher.bulk_check",
    entity: "fin_payment_vouchers",
    entityId: null,
    diff: { done: r.done, failed: r.failed.map((f) => ({ id: f.id, code: f.code })) },
  });
  refresh();
  const codes = [...new Set(r.failed.map((f) => f.code))];
  return {
    ok: true,
    data: { done: r.done.length, failed: r.failed.length },
    message:
      r.failed.length === 0
        ? `${r.done.length} voucher(s) verified.`
        : `${r.done.length} verified, ${r.failed.length} not: ${codes.map((c) => voucherErrorMessage(c, c)).join(" ")}`,
  };
}
