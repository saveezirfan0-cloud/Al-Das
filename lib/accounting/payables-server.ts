import "server-only";

import {
  buildPayablesAgeing,
  buildSupplierStatement,
  type PayableInvoice,
  type PayablesAgeing,
  type SupplierPayment,
  type SupplierRef,
  type SupplierStatement,
} from "@/lib/accounting/payables-ageing";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Reads for the payables ageing and supplier statements (Phase G). Service role; callers have run can() for a payables
 * read key (PAYABLES_READ). Every list is read in pages (fetchAll), never capped.
 */

async function must<T>(p: PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const { data, error } = await p;
  if (error || !data) throw new Error("payables read failed");
  return data;
}

export async function loadSuppliers(admin: AdminClient, orgId: string): Promise<SupplierRef[]> {
  const rows = await must(
    fetchAll((from, to) =>
      admin
        .from("fin_suppliers")
        .select("id, name, payment_terms_days")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
  );
  return rows
    .map((s) => ({ id: s.id, name: s.name, termsDays: s.payment_terms_days }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadPayables(
  admin: AdminClient,
  orgId: string,
  upTo: string,
  supplierId: string | null,
): Promise<{ invoices: PayableInvoice[]; payments: SupplierPayment[] }> {
  const [invoices, vouchers] = await Promise.all([
    must(
      fetchAll((from, to) => {
        let q = admin
          .from("fin_supplier_invoices")
          .select(
            "id, supplier_id, invoice_number, invoice_date, due_date, total, currency, status",
          )
          .eq("org_id", orgId)
          .lte("invoice_date", upTo);
        if (supplierId) q = q.eq("supplier_id", supplierId);
        return q.order("id").range(from, to);
      }),
    ),
    must(
      fetchAll((from, to) => {
        let q = admin
          .from("fin_payment_vouchers")
          .select("id, voucher_no, supplier_id, amount, currency, payment_date")
          .eq("org_id", orgId)
          .eq("status", "paid")
          // every paid voucher, also those paid after the date: they tell which invoices were still open then
          .not("supplier_id", "is", null);
        if (supplierId) q = q.eq("supplier_id", supplierId);
        return q.order("id").range(from, to);
      }),
    ),
  ]);
  const voucherIds = vouchers.map((v) => v.id);
  const links: Array<{ voucher_id: string; supplier_invoice_id: string }> = [];
  // the links of these vouchers, a few hundred ids per request so the URL stays short
  for (let i = 0; i < voucherIds.length; i += 200) {
    const chunk = voucherIds.slice(i, i + 200);
    links.push(
      ...(await must(
        fetchAll((from, to) =>
          admin
            .from("fin_voucher_invoices")
            .select("voucher_id, supplier_invoice_id")
            .eq("org_id", orgId)
            .in("voucher_id", chunk)
            .order("voucher_id")
            .order("supplier_invoice_id")
            .range(from, to),
        ),
      )),
    );
  }
  const byVoucher = new Map<string, string[]>();
  for (const l of links)
    byVoucher.set(l.voucher_id, [...(byVoucher.get(l.voucher_id) ?? []), l.supplier_invoice_id]);
  return {
    invoices: invoices.map((i) => ({
      id: i.id,
      supplierId: i.supplier_id,
      number: i.invoice_number,
      invoiceDate: i.invoice_date,
      dueDate: i.due_date,
      total: i.total ?? 0,
      currency: i.currency,
      status: i.status,
    })),
    payments: vouchers.map((v) => ({
      id: v.id,
      supplierId: v.supplier_id!,
      voucherNo: v.voucher_no,
      date: v.payment_date,
      amount: v.amount,
      currency: v.currency,
      invoiceIds: byVoucher.get(v.id) ?? [],
    })),
  };
}

export async function loadPayablesAgeing(
  admin: AdminClient,
  orgId: string,
  asOf: string,
): Promise<PayablesAgeing> {
  const [suppliers, { invoices, payments }] = await Promise.all([
    loadSuppliers(admin, orgId),
    loadPayables(admin, orgId, asOf, null),
  ]);
  return buildPayablesAgeing(invoices, payments, suppliers, asOf);
}

export async function loadSupplierStatement(
  admin: AdminClient,
  orgId: string,
  supplierId: string,
  from: string,
  to: string,
): Promise<(SupplierStatement & { supplier: SupplierRef }) | null> {
  const suppliers = await loadSuppliers(admin, orgId);
  const supplier = suppliers.find((s) => s.id === supplierId);
  if (!supplier) return null;
  const { invoices, payments } = await loadPayables(admin, orgId, to, supplierId);
  return { ...buildSupplierStatement(invoices, payments, from, to), supplier };
}
