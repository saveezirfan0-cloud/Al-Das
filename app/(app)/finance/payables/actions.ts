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
  optionalDate,
  optionalText,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  abandonFinanceDocument,
  FINANCE_DOCUMENT_KINDS,
  finalizeFinanceDocument,
  prepareFinanceDocument,
  signedFinanceDocumentUrl,
  type FinalizedDocument,
} from "@/lib/finance/finance-documents";
import { voucherErrorMessage } from "@/lib/finance/vouchers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Suppliers, supplier invoices and the finance documents attached to them (Phase 20D). Suppliers and invoices need
 * finance.payables.manage; uploading a document also suits a voucher maker (finance.vouchers.prepare); opening one needs
 * any payables or voucher permission and is written to the access log. Writes use the service role after the check and
 * are audited. Supplier invoices dated in a locked month cannot change (database trigger).
 */

const MANAGE = ["finance.payables.manage"] as const;
const UPLOAD = ["finance.payables.manage", "finance.vouchers.prepare"] as const;
const READ = [
  "finance.payables.view",
  "finance.payables.manage",
  "finance.vouchers.prepare",
  "finance.vouchers.check",
  "finance.vouchers.approve_dept",
  "finance.vouchers.approve_ceo",
  "finance.vouchers.pay",
  "finance.tally.export",
] as const;

async function gate(perms: readonly string[]) {
  const member = await requireMember();
  return canAny(member, perms) ? member : null;
}

function refresh() {
  revalidatePath("/finance/suppliers");
  revalidatePath("/finance/payables");
  revalidatePath("/finance/vouchers");
}

/** Database errors we expect, by SQLSTATE and our own hint; never the raw message. */
function dbError(err: { code?: string; hint?: string | null } | null, fallback: string): string {
  if (err?.code === "23505")
    return "That already exists (the same invoice number for this supplier, or the same name).";
  if (err?.code === "42501") return "The month is locked; nothing dated in it can change.";
  if (err?.code === "23503") return "That refers to something that no longer exists.";
  return voucherErrorMessage(err?.hint, fallback);
}

// ---------------------------------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------------------------------

const supplierSchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  name: z
    .string()
    .trim()
    .min(1, "Give the supplier a name.")
    .max(120, "Name: at most 120 characters."),
  trn: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[0-9A-Z-]{5,20}$/.test(v), "TRN: 5 to 20 digits or letters.")
    .transform((v) => (v === "" ? null : v)),
  default_category: optionalText(60),
  payment_terms_days: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 365),
      "Terms: 0 to 365 days.",
    ),
  active: z.string().optional(),
});

export async function saveSupplier(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = supplierSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    name: v.name,
    trn: v.trn,
    default_category: v.default_category,
    payment_terms_days: v.payment_terms_days,
    active: v.id ? v.active === "on" : true,
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_suppliers")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("fin_suppliers")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (error || !data) return fail(dbError(error, "Could not save the supplier."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.supplier.updated" : "finance.supplier.created",
    entity: "fin_suppliers",
    entityId: data.id,
    diff: { active: row.active, has_trn: !!row.trn, terms: row.payment_terms_days },
  });
  refresh();
  return { ok: true, data: { id: data.id }, message: "Supplier saved." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Supplier invoices
// ---------------------------------------------------------------------------------------------------------------------

const amount = (label: string, required: boolean) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? (required ? NaN : 0) : Number(v.replace(/,/g, ""))))
    .refine(
      (v) => Number.isFinite(v) && v >= 0 && v < 1e11,
      `${label}: enter an amount of zero or more.`,
    )
    .transform((v) => Math.round(v * 100) / 100);

const invoiceSchema = z
  .object({
    id: z.union([uuid, z.literal("")]).default(""),
    supplier_id: uuid,
    invoice_number: z.string().trim().min(1, "Enter the invoice number.").max(60),
    invoice_date: isoDate,
    due_date: optionalDate,
    category: z.string().trim().min(1, "Choose or type a category.").max(60),
    net: amount("Net", true),
    vat: amount("VAT", false),
    branch_code: optionalText(20),
    cost_centre: optionalText(40),
    doctor_dha_id: optionalText(40),
    document_id: z.union([uuid, z.literal("")]).default(""),
  })
  .refine((v) => v.net + v.vat > 0, { message: "The invoice total must be more than zero." })
  .refine((v) => !v.due_date || v.due_date >= v.invoice_date, {
    message: "The due date cannot be before the invoice date.",
  });

export async function saveSupplierInvoice(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = invoiceSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const row = {
    supplier_id: v.supplier_id,
    invoice_number: v.invoice_number,
    invoice_date: v.invoice_date,
    due_date: v.due_date,
    category: v.category,
    net: v.net,
    vat: v.vat,
    branch_code: v.branch_code,
    cost_centre: v.cost_centre,
    doctor_dha_id: v.doctor_dha_id,
    document_id: v.document_id || null,
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_supplier_invoices")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("fin_supplier_invoices")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (error || !data) return fail(dbError(error, "Could not save the invoice."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.supplier_invoice.updated" : "finance.supplier_invoice.created",
    entity: "fin_supplier_invoices",
    entityId: data.id,
    diff: {
      total: Math.round((v.net + v.vat) * 100) / 100,
      has_document: !!v.document_id,
      date: v.invoice_date,
    },
  });
  refresh();
  return { ok: true, data: { id: data.id }, message: "Invoice saved." };
}

export async function voidSupplierInvoice(raw: { id: string }): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_supplier_invoices")
    .update({ status: "void" })
    .eq("id", raw.id)
    .eq("org_id", member.orgId)
    .eq("status", "open")
    .is("tally_export_id", null)
    .select("id")
    .maybeSingle();
  if (error) return fail(dbError(error, "Could not void the invoice."));
  if (!data)
    return fail("Only an open invoice that is not on a voucher and not exported can be voided.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.supplier_invoice.voided",
    entity: "fin_supplier_invoices",
    entityId: raw.id,
  });
  refresh();
  return { ok: true, message: "Invoice voided." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents: prepare -> browser upload -> finalise; open through a 60-second link
// ---------------------------------------------------------------------------------------------------------------------

const prepareSchema = z.object({
  kind: z.enum(FINANCE_DOCUMENT_KINDS),
  mime: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export async function prepareFinanceUpload(
  raw: z.input<typeof prepareSchema>,
): Promise<ActionResult<{ documentId: string; path: string; token: string }>> {
  const member = await gate(UPLOAD);
  if (!member) return fail(DENIED);
  const p = prepareSchema.safeParse(raw);
  if (!p.success) return fail("Choose a file.");
  const admin = createAdminClient(member.userId);
  const res = await prepareFinanceDocument(admin, member, p.data);
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}

export async function finalizeFinanceUpload(raw: {
  id: string;
}): Promise<ActionResult<FinalizedDocument>> {
  const member = await gate(UPLOAD);
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const res = await finalizeFinanceDocument(admin, member, raw.id);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: res.ok
      ? res.data.duplicateOf
        ? "finance.document.duplicate"
        : "finance.document.uploaded"
      : "finance.document.upload_rejected",
    entity: "fin_documents",
    entityId: res.ok ? res.data.id : raw.id,
    diff: res.ok ? { kind: res.data.kind, size: res.data.size, scan: res.data.scan } : null,
  });
  if (!res.ok) return fail(res.error);
  return { ok: true, data: res.data, message: res.message };
}

export async function abandonFinanceUpload(raw: { id: string }): Promise<ActionResult> {
  const member = await gate(UPLOAD);
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return { ok: true };
  const admin = createAdminClient(member.userId);
  if (await abandonFinanceDocument(admin, member, raw.id))
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.document.upload_cancelled",
      entity: "fin_documents",
      entityId: raw.id,
    });
  return { ok: true };
}

export async function openFinanceDocument(raw: {
  id: string;
  mode?: "view" | "download";
}): Promise<ActionResult<{ url: string }>> {
  const member = await gate(READ);
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const res = await signedFinanceDocumentUrl(
    admin,
    member,
    raw.id,
    raw.mode === "download" ? "download" : "view",
  );
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}
