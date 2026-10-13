import { NextResponse } from "next/server";

import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import {
  customerBlock,
  loadSalesDetail,
  loadSeller,
  sellerBlock,
} from "@/lib/accounting/receivables-server";
import { taxInvoicePdf } from "@/lib/accounting/sales-pdf";
import { invoiceTotals } from "@/lib/accounting/sales";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/accounting/sales-invoices/<id>/pdf -> the tax invoice or tax credit note PDF of an issued document, rendered from
 * the stored document. Needs a receivables read key. Audited and written to the export log.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, RECEIVABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  const d = await loadSalesDetail(admin, member.orgId, id);
  if (!d || d.status === "draft" || !d.number)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const seller = await loadSeller(admin, member.orgId, d.entity_id);
  const pdf = await taxInvoicePdf({
    kind: d.kind,
    form: d.invoice_form,
    status: d.status,
    number: d.number,
    date: d.invoice_date,
    supplyDate: d.supply_date,
    dueDate: d.due_date,
    reference: d.reference,
    seller: sellerBlock(seller),
    customer:
      d.invoice_form === "simplified"
        ? { ...customerBlock(d.customer), trn: null }
        : customerBlock(d.customer),
    original: d.original ? { number: d.original.number, date: d.original.invoice_date } : null,
    creditReason: d.credit_reason,
    eventDate: d.event_date,
    lines: d.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discount: l.discount,
      net: l.net,
      vatRate: l.vat_rate,
      vat: l.vat_amount,
      total: l.line_total,
    })),
    totals: {
      ...invoiceTotals(
        d.lines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.unit_price,
          discount: l.discount,
          vatRate: l.vat_rate,
        })),
      ),
      // the stored totals are the document's; the per-rate summary comes from the same line amounts
      subtotal: d.subtotal,
      discount: d.discount_total,
      net: d.net_total,
      vat: d.vat_total,
      total: d.total,
    },
    notes: d.notes,
    paymentInstructions: seller.paymentInstructions,
    sha256: d.content_sha256,
    issuedAt: d.issued_at,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_document.pdf_downloaded",
    entity: "acc_sales_invoices",
    entityId: d.id,
    diff: { number: d.number, kind: d.kind },
  });
  await recordExport(admin, member, { dataset: `accounting:${d.kind}`, rows: 1, format: "pdf" });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${d.number.replace(/[^A-Za-z0-9-]/g, "_")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
