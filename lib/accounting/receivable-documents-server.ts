import "server-only";

import {
  customerBlock,
  loadCustomer,
  loadOpenItems,
  loadSeller,
  loadStatement,
  sellerBlock,
  type CustomerView,
} from "@/lib/accounting/receivables-server";
import { balanceConfirmationPdf, statementPdf } from "@/lib/accounting/sales-pdf";
import { statementWorkbook } from "@/lib/accounting/statement-xlsx";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The customer statement and the balance-confirmation letter, rendered from stored data in one place so the download
 * routes and the e-mail job send the same document. Service role; callers have run can() (a receivables read key).
 * Business customers only: acc_customers never holds a patient.
 */

export async function renderCustomerStatement(
  admin: AdminClient,
  orgId: string,
  customerId: string,
  from: string,
  to: string,
  format: "pdf" | "xlsx",
): Promise<{ body: Buffer; rows: number; closing: number; customer: CustomerView } | null> {
  const s = await loadStatement(admin, orgId, customerId, from, to);
  if (!s) return null;
  const seller = await loadSeller(admin, orgId, null);
  const input = {
    seller: sellerBlock(seller),
    customer: customerBlock(s.customer),
    from,
    to,
    opening: s.opening,
    rows: s.rows,
    closing: s.closing,
    paymentInstructions: seller.paymentInstructions,
    builtAt: new Date().toISOString(),
  };
  const body = format === "xlsx" ? await statementWorkbook(input) : await statementPdf(input);
  return { body, rows: s.rows.length, closing: s.closing, customer: s.customer };
}

export async function renderBalanceConfirmation(
  admin: AdminClient,
  orgId: string,
  customerId: string,
  asOf: string,
): Promise<{ body: Buffer; rows: number; balance: number; customer: CustomerView } | null> {
  const customer = await loadCustomer(admin, orgId, customerId);
  if (!customer) return null;
  const [items, seller] = await Promise.all([
    loadOpenItems(admin, orgId, customerId, asOf),
    loadSeller(admin, orgId, null),
  ]);
  const balance =
    Math.round(
      (items.invoices.reduce((s, i) => s + i.open, 0) -
        items.on_account.reduce((s, r) => s + r.unallocated, 0)) *
        100,
    ) / 100;
  const body = await balanceConfirmationPdf({
    seller: sellerBlock(seller),
    customer: customerBlock(customer),
    asOf,
    balance,
    invoices: items.invoices.map((i) => ({
      number: i.number,
      date: i.invoice_date,
      due: i.due_date,
      open: i.open,
    })),
    onAccount: items.on_account.map((r) => ({
      number: r.number,
      date: r.receipt_date,
      amount: r.unallocated,
    })),
    builtAt: new Date().toISOString(),
  });
  return { body, rows: items.invoices.length + items.on_account.length, balance, customer };
}
