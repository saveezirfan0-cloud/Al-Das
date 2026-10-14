"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { RECEIPT_MODES } from "@/lib/accounting/sales";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { redactStatementText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Receipts (Phase 22E), accounting.receipts.manage. A receipt is posted when it is recorded (Dr bank / cash / clearing,
 * Cr the customer's receivable) and allocated oldest invoice first unless the person allocates it by hand; what is left
 * is on account. Insurer remittances stay in the Phase 18 remittance flow (posted by 22D), not here. Audited with ids and
 * amounts only.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

function refresh(id?: string) {
  revalidatePath("/accounting/receipts");
  revalidatePath("/accounting/sales-invoices");
  revalidatePath("/accounting/receivables-ageing");
  if (id) revalidatePath(`/accounting/receipts/${id}`);
}

const money2 = z.coerce
  .number()
  .refine((n) => Number.isFinite(n) && n > 0 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6, {
    message: "Amounts are positive with at most two decimals.",
  });

const allocationSchema = z.object({ invoice_id: uuid, amount: money2 });

const receiptSchema = z.object({
  customer_id: uuid,
  receipt_date: isoDate,
  account_id: uuid,
  amount: money2,
  mode: z.enum(RECEIPT_MODES),
  reference: z.string().max(200).default(""),
  notes: z.string().max(600).default(""),
  /** null = oldest invoice first */
  allocations: z.array(allocationSchema).max(500).nullable().default(null),
  /** A receipt by cheque names the received cheque in the register (22K); the receipt then posts it. */
  cheque_id: uuid.nullable().default(null),
});

export async function saveReceipt(
  raw: z.input<typeof receiptSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.receipts.manage");
  if (!member) return fail(DENIED);
  const p = receiptSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_receipt_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_receipt: {
      customer_id: v.customer_id,
      receipt_date: v.receipt_date,
      account_id: v.account_id,
      amount: v.amount,
      mode: v.mode,
      reference: redactStatementText(v.reference, 60) ?? "",
      notes: redactStatementText(v.notes, 300) ?? "",
      cheque_id: v.mode === "cheque" ? v.cheque_id : null,
    },
    p_allocations: v.allocations as Json,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The receipt could not be saved."));
  const r = data as {
    id: string;
    number: string;
    posting_status: string;
    allocated: number;
    unallocated: number;
  };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.receipt.created",
    entity: "acc_receipts",
    entityId: r.id,
    diff: {
      number: r.number,
      amount: v.amount,
      allocated: r.allocated,
      oldest_first: v.allocations === null,
      posting: r.posting_status,
    },
  });
  refresh(r.id);
  return {
    ok: true,
    data: { id: r.id },
    message: `Recorded as ${r.number}${r.unallocated > 0 ? `; ${r.unallocated.toFixed(2)} on account` : ""}.`,
  };
}

const allocateSchema = z.object({
  id: uuid,
  allocations: z.array(allocationSchema).max(500).nullable(),
});

/** Replace a receipt's allocations (null = oldest invoice first). */
export async function allocateReceipt(raw: z.input<typeof allocateSchema>): Promise<ActionResult> {
  const p = allocateSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const member = await gate("accounting.receipts.manage");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_receipt_allocate", {
    p_org_id: member.orgId,
    p_receipt_id: p.data.id,
    p_user_id: member.userId,
    p_allocations: p.data.allocations as Json,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The allocation could not be saved."));
  const r = data as { allocated: number; unallocated: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.receipt.allocated",
    entity: "acc_receipts",
    entityId: p.data.id,
    diff: { allocated: r.allocated, invoices: p.data.allocations?.length ?? null },
  });
  refresh(p.data.id);
  return { ok: true, message: "Allocation saved." };
}

const voidSchema = z.object({
  id: uuid,
  date: isoDate,
  reason: z.string().trim().min(3, "Say why the receipt is voided.").max(200),
});

/** Void a receipt (a bounced cheque, a wrong entry): the journal is reversed and its invoices are open again. */
export async function voidReceipt(raw: z.input<typeof voidSchema>): Promise<ActionResult> {
  const p = voidSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const member = await gate("accounting.receipts.manage");
  if (!member) return fail(DENIED);
  const reason = redactStatementText(p.data.reason, 200);
  if (!reason || reason.length < 3) return fail("Say why the receipt is voided.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_receipt_void", {
    p_org_id: member.orgId,
    p_receipt_id: p.data.id,
    p_user_id: member.userId,
    p_date: p.data.date,
    p_reason: reason,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The receipt could not be voided."));
  const r = data as { reversal_id: string | null; reversal_number: string | null };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.receipt.voided",
    entity: "acc_receipts",
    entityId: p.data.id,
    diff: { reversal_id: r.reversal_id, reversal_number: r.reversal_number, date: p.data.date },
  });
  refresh(p.data.id);
  return { ok: true, message: "Receipt voided." };
}
