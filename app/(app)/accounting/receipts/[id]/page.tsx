import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadOpenInvoices, loadReceiptDetail } from "@/lib/accounting/receivables-server";
import { POSTING_STATUS_LABELS, RECEIPT_MODE_LABELS, type ReceiptMode } from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { VoidReceipt } from "../controls";
import { ReallocateForm } from "../receipt-form";

export const metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.receipts.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const r = await loadReceiptDetail(admin, member.orgId, id);
  if (!r) notFound();
  await recordAccess(admin, member, { entity: "accounting_receivable", entityId: r.id, action: "view" });
  const manage = can(member, "accounting.receipts.manage") && r.status === "active";

  // what this receipt could be allocated to: everything open, plus what it already holds
  let invoices: Array<{ id: string; number: string; invoiceDate: string; open: number; total: number }> = [];
  if (manage) {
    const open = await loadOpenInvoices(admin, member.orgId, r.customer_id);
    const byId = new Map(open.map((i) => [i.id, { ...i }]));
    for (const a of r.allocations) {
      const cur = byId.get(a.invoice_id);
      if (cur) cur.open = Math.round((cur.open + a.amount) * 100) / 100;
      else
        byId.set(a.invoice_id, {
          id: a.invoice_id,
          number: a.number ?? "-",
          invoiceDate: a.invoice_date,
          open: a.amount,
          total: a.amount,
        });
    }
    invoices = [...byId.values()].sort(
      (x, y) => x.invoiceDate.localeCompare(y.invoiceDate) || x.number.localeCompare(y.number),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={`Receipt ${r.number}`} description={`${r.customer}, ${r.receipt_date}`}>
        {r.status === "void" && <Badge variant="secondary">Void</Badge>}
        {manage && <VoidReceipt id={r.id} defaultDate={new Date().toISOString().slice(0, 10)} />}
      </PageHeader>
      <Card>
        <CardContent className="grid grid-cols-2 gap-1 pt-6 text-sm sm:grid-cols-4">
          <span className="text-muted-foreground">Amount</span>
          <span className="tabular-nums">AED {money(r.amount)}</span>
          <span className="text-muted-foreground">On account</span>
          <span className="tabular-nums">{money(r.amount - r.amount_allocated)}</span>
          <span className="text-muted-foreground">Received into</span>
          <span>{r.account}</span>
          <span className="text-muted-foreground">Mode</span>
          <span>{RECEIPT_MODE_LABELS[r.mode as ReceiptMode] ?? r.mode}</span>
          <span className="text-muted-foreground">Reference</span>
          <span>{r.reference ?? "-"}</span>
          <span className="text-muted-foreground">Recorded by</span>
          <span>{r.prepared}</span>
          <span className="text-muted-foreground">Ledger</span>
          <span>
            {r.journal ? (
              <Link className="underline" href={`/accounting/journals/${r.journal.id}`}>
                {r.journal.number}
              </Link>
            ) : (
              POSTING_STATUS_LABELS[r.posting_status]
            )}
          </span>
          {r.status === "void" && (
            <>
              <span className="text-muted-foreground">Voided</span>
              <span>{r.void_reason}</span>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allocated to</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {r.allocations.length === 0 && <p className="text-muted-foreground">Nothing: all on account.</p>}
          {r.allocations.map((a) => (
            <Link key={a.invoice_id} className="underline" href={`/accounting/sales-invoices/${a.invoice_id}`}>
              {a.number}, {a.invoice_date}: {money(a.amount)}
            </Link>
          ))}
          {manage && (
            <details>
              <summary className="cursor-pointer font-medium">Change the allocation</summary>
              <div className="mt-3">
                <ReallocateForm
                  receiptId={r.id}
                  amount={r.amount}
                  invoices={invoices}
                  current={Object.fromEntries(r.allocations.map((a) => [a.invoice_id, a.amount.toFixed(2)]))}
                />
              </div>
            </details>
          )}
        </CardContent>
      </Card>
      {r.notes && <p className="text-muted-foreground text-sm">Notes: {r.notes}</p>}
    </div>
  );
}
