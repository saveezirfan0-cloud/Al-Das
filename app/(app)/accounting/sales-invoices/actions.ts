"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { cleanDescription } from "@/lib/accounting/journal";
import {
  invoiceTotals,
  lineProblem,
  MAX_SALES_LINES,
  SALES_ERRORS,
} from "@/lib/accounting/sales";
import { recordAudit } from "@/lib/audit";
import { can, canAny } from "@/lib/auth/can";
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

/**
 * Sales invoices and credit notes (Phase 22E). Drafts, discards and voids need accounting.sales.manage; issuing up to the
 * approval limit too, above it accounting.journals.approve held by someone other than the preparer (the database checks
 * both, and the content hash the approver reviewed). Totals are computed here with lib/accounting/sales.ts and again in
 * SQL; a mismatch is refused. Audit rows carry ids, numbers and amounts only.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

async function gateAny(permissions: readonly string[]) {
  const member = await requireMember();
  return canAny(member, permissions) ? member : null;
}

function refresh(id?: string) {
  revalidatePath("/accounting/sales-invoices");
  revalidatePath("/accounting/credit-notes");
  revalidatePath("/accounting/receivables-ageing");
  if (id) revalidatePath(`/accounting/sales-invoices/${id}`);
}

const optionalId = z.union([uuid, z.literal("")]).default("");
const optionalDate = z.union([isoDate, z.literal("")]).default("");
const num = z.coerce.number().refine((n) => Number.isFinite(n), "Enter numbers.");

const lineSchema = z.object({
  description: z.string().max(400),
  quantity: num,
  unit_price: num,
  discount: num.default(0),
  income_account_id: uuid,
  tax_code_id: uuid,
  branch_code: z.string().trim().max(20).default(""),
  department: z.string().trim().max(60).default(""),
  cost_centre_id: optionalId,
});

const docSchema = z.object({
  id: optionalId,
  kind: z.enum(["invoice", "credit_note"]),
  customer_id: uuid,
  original_invoice_id: optionalId,
  invoice_date: isoDate,
  supply_date: optionalDate,
  due_date: optionalDate,
  event_date: optionalDate,
  credit_reason: z.string().max(400).default(""),
  reference: z.string().trim().max(60).default(""),
  notes: z.string().max(1000).default(""),
  lines: z.array(lineSchema).min(1, "Add at least one line.").max(MAX_SALES_LINES),
});

export type SalesDocInput = z.input<typeof docSchema>;

export async function saveSalesDoc(
  raw: SalesDocInput,
): Promise<ActionResult<{ id: string; sha256: string }>> {
  const member = await gate("accounting.sales.manage");
  if (!member) return fail(DENIED);
  const p = docSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data: taxes } = await admin
    .from("acc_tax_codes")
    .select("id, rate")
    .eq("org_id", member.orgId)
    .in(
      "id",
      v.lines.map((l) => l.tax_code_id),
    );
  const rateOf = new Map((taxes ?? []).map((t) => [t.id, Number(t.rate)]));
  const priced = [];
  for (const [i, l] of v.lines.entries()) {
    const rate = rateOf.get(l.tax_code_id);
    if (rate === undefined) return fail(`Line ${i + 1}: ${SALES_ERRORS.sales_tax_code}`);
    const input = { quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, vatRate: rate };
    if (lineProblem(input)) return fail(`Line ${i + 1}: ${SALES_ERRORS.bad_line}`);
    const description = cleanDescription(l.description);
    if (!description) return fail(`Line ${i + 1}: describe what is sold.`);
    priced.push({ input, line: { ...l, description } });
  }
  const totals = invoiceTotals(priced.map((x) => x.input));
  const { data, error } = await admin.rpc("acc_sales_doc_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_doc_id: (v.id || null) as string,
    p_header: {
      kind: v.kind,
      customer_id: v.customer_id,
      original_invoice_id: v.original_invoice_id,
      invoice_date: v.invoice_date,
      supply_date: v.supply_date,
      due_date: v.due_date,
      event_date: v.event_date,
      credit_reason: redactStatementText(v.credit_reason, 200) ?? "",
      reference: redactStatementText(v.reference, 60) ?? "",
      notes: redactStatementText(v.notes, 500) ?? "",
      expected_total: totals.total,
    },
    p_lines: priced.map((x) => x.line),
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The document could not be saved."));
  const r = data as { id: string; sha256: string; total: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? `accounting.${v.kind}.updated` : `accounting.${v.kind}.created`,
    entity: "acc_sales_invoices",
    entityId: r.id,
    diff: { kind: v.kind, lines: v.lines.length, total: r.total },
  });
  refresh(r.id);
  return { ok: true, data: { id: r.id, sha256: r.sha256 }, message: "Draft saved." };
}

const issueSchema = z.object({
  id: uuid,
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});

/** Issue a draft: number, tax invoice form, journal. Above the approval limit, the approver issues it with the hash. */
export async function issueSalesDoc(
  raw: z.input<typeof issueSchema>,
): Promise<ActionResult<{ number: string }>> {
  const p = issueSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const member = await gateAny(["accounting.sales.manage", "accounting.journals.approve"]);
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_sales_doc_issue", {
    p_org_id: member.orgId,
    p_doc_id: p.data.id,
    p_user_id: member.userId,
    p_hash: p.data.hash as string,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The document could not be issued."));
  const r = data as {
    number: string;
    total: number;
    posting_status: string;
    invoice_form: string;
    sha256: string;
  };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_document.issued",
    entity: "acc_sales_invoices",
    entityId: p.data.id,
    diff: {
      number: r.number,
      total: r.total,
      posting: r.posting_status,
      form: r.invoice_form,
      sha256: r.sha256,
    },
  });
  refresh(p.data.id);
  const waiting =
    r.posting_status === "waiting_ledger_start"
      ? " It is before the ledger start, so it waits (Tally holds the books for that date)."
      : "";
  return { ok: true, data: { number: r.number }, message: `Issued as ${r.number}.${waiting}` };
}

export async function discardSalesDoc(raw: { id: string }): Promise<ActionResult> {
  const p = z.object({ id: uuid }).safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const member = await gate("accounting.sales.manage");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_sales_doc_discard", {
    p_org_id: member.orgId,
    p_doc_id: p.data.id,
    p_user_id: member.userId,
  });
  if (error) return fail(rpcErrorMessage(error, "The draft could not be deleted."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_document.discarded",
    entity: "acc_sales_invoices",
    entityId: p.data.id,
    diff: {},
  });
  refresh();
  return { ok: true, message: "Draft deleted." };
}

const voidSchema = z.object({
  id: uuid,
  date: isoDate,
  reason: z.string().trim().min(3, "Say why the invoice is voided.").max(200),
});

/** Void an issued invoice: a credit note in full is issued on the date given. */
export async function voidSalesInvoice(
  raw: z.input<typeof voidSchema>,
): Promise<ActionResult<{ creditNoteId: string }>> {
  const p = voidSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const member = await gateAny(["accounting.sales.manage", "accounting.journals.approve"]);
  if (!member) return fail(DENIED);
  const reason = redactStatementText(p.data.reason, 200);
  if (!reason || reason.length < 3) return fail("Say why the invoice is voided.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_sales_invoice_void", {
    p_org_id: member.orgId,
    p_invoice_id: p.data.id,
    p_user_id: member.userId,
    p_date: p.data.date,
    p_reason: reason,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The invoice could not be voided."));
  const r = data as { credit_note_id: string; credit_note_number: string; posting_status: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_invoice.voided",
    entity: "acc_sales_invoices",
    entityId: p.data.id,
    diff: {
      credit_note_id: r.credit_note_id,
      credit_note_number: r.credit_note_number,
      date: p.data.date,
      posting: r.posting_status,
    },
  });
  refresh(p.data.id);
  refresh(r.credit_note_id);
  return {
    ok: true,
    data: { creditNoteId: r.credit_note_id },
    message: `Voided by credit note ${r.credit_note_number}.`,
  };
}

/** Post the documents and receipts still waiting for the ledger start (once the start date allows it). */
export async function retryReceivablePostings(): Promise<ActionResult> {
  const member = await gateAny(["accounting.sales.manage", "accounting.receipts.manage"]);
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_ar_retry_postings", { p_org_id: member.orgId });
  if (error || !data) return fail(rpcErrorMessage(error, "The postings could not be retried."));
  const r = data as { posted: number; waiting: number; failed: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.receivables.postings_retried",
    entity: "acc_sales_invoices",
    diff: r,
  });
  refresh();
  revalidatePath("/accounting/receipts");
  return {
    ok: true,
    message: `Posted ${r.posted}; ${r.waiting} still waiting${r.failed ? `; ${r.failed} refused (open each to see why)` : ""}.`,
  };
}
