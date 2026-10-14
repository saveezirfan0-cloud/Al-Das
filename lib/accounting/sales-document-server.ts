import "server-only";

import {
  customerBlock,
  loadSalesDetail,
  loadSeller,
  sellerBlock,
} from "@/lib/accounting/receivables-server";
import { invoiceTotals } from "@/lib/accounting/sales";
import { taxInvoicePdf } from "@/lib/accounting/sales-pdf";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * One issued sales document (tax invoice or tax credit note) as PDF, rendered from the stored document: the download
 * route serves the tax invoice itself, the e-mail job (Phase G) a copy marked "Internal copy - not a tax invoice".
 * Service role; callers have checked the receivables permission (the route) or that the document belongs to the
 * confirmed business customer (the job). A draft has no number and is never rendered.
 */
export type RenderedSalesDocument = {
  id: string;
  pdf: Buffer;
  number: string;
  date: string;
  kind: "invoice" | "credit_note";
  customerId: string;
  status: string;
  contentSha256: string | null;
};

export async function renderSalesDocument(
  admin: AdminClient,
  orgId: string,
  id: string,
  opts: { copy?: boolean } = {},
): Promise<RenderedSalesDocument | null> {
  const d = await loadSalesDetail(admin, orgId, id);
  if (!d || d.status === "draft" || !d.number) return null;
  const seller = await loadSeller(admin, orgId, d.entity_id);
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
    copy: opts.copy ?? false,
  });
  return {
    id: d.id,
    pdf,
    number: d.number,
    date: d.invoice_date,
    kind: d.kind,
    customerId: d.customer.id,
    status: d.status,
    contentSha256: d.content_sha256,
  };
}
