import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadArSettings, loadSalesDetail } from "@/lib/accounting/receivables-server";
import { creditNoteLate, invoiceTotals, POSTING_STATUS_LABELS } from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { SalesStatusBadge } from "../list";
import { DiscardSalesDoc, IssueSalesDoc, VoidSalesInvoice } from "../controls";

export const metadata = { title: "Sales document" };
export const dynamic = "force-dynamic";

export default async function SalesDocPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.sales.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const [d, settings] = await Promise.all([
    loadSalesDetail(admin, member.orgId, id),
    loadArSettings(admin, member.orgId),
  ]);
  if (!d) notFound();
  await recordAccess(admin, member, { entity: "accounting_receivable", entityId: d.id, action: "view" });

  const credit = d.kind === "credit_note";
  const sales = can(member, "accounting.sales.manage");
  const approver = can(member, "accounting.journals.approve");
  const aboveLimit = d.total > settings.issue_approval_threshold;
  const mine = d.people.preparedId === member.userId;
  const open = d.total - d.amount_credited - d.amount_paid;
  const live = d.status === "issued" || d.status === "part_paid" || d.status === "paid";
  const vat = invoiceTotals(
    d.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discount: l.discount,
      vatRate: l.vat_rate,
    })),
  ).byRate;
  const title = `${credit ? "Credit note" : "Sales invoice"} ${d.number ?? "(draft)"}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={`${d.customer.name}, ${d.invoice_date}`}>
        <SalesStatusBadge status={d.status} needsApproval={d.status === "draft" && aboveLimit} />
        {d.status !== "draft" && (
          <Button asChild variant="outline" size="sm">
            <a href={`/api/accounting/sales-invoices/${d.id}/pdf`}>PDF</a>
          </Button>
        )}
        {d.status === "draft" && sales && (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/accounting/sales-invoices/${d.id}/edit`}>Edit</Link>
            </Button>
            <DiscardSalesDoc id={d.id} back={credit ? "/accounting/credit-notes" : "/accounting/sales-invoices"} />
          </>
        )}
        {d.status === "draft" && !aboveLimit && sales && (
          <IssueSalesDoc id={d.id} hash={d.content_sha256} approve={false} label="Issue" />
        )}
        {d.status === "draft" && aboveLimit && approver && !mine && (
          <IssueSalesDoc id={d.id} hash={d.content_sha256} approve label="Approve and issue" />
        )}
        {!credit && live && sales && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/accounting/sales-invoices/new?credit_for=${d.id}`}>Credit note</Link>
          </Button>
        )}
        {!credit &&
          live &&
          d.allocations.length === 0 &&
          d.creditNotes.every((c) => c.status === "draft") &&
          (aboveLimit ? approver : sales) && (
            <VoidSalesInvoice id={d.id} defaultDate={new Date().toISOString().slice(0, 10)} />
          )}
      </PageHeader>

      {d.status === "draft" && aboveLimit && (
        <p className="rounded-md border p-3 text-sm">
          Above the approval limit (AED {money(settings.issue_approval_threshold)}). Someone other than the preparer,
          with the journal approval permission, reviews it and presses Approve and issue.
          {mine && " You prepared it, so someone else issues it."}
        </p>
      )}
      {credit && creditNoteLate(d.event_date, d.invoice_date, settings.credit_note_days) && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Dated more than {settings.credit_note_days} days after its event ({d.event_date}). The FTA expects a tax
          credit note within 14 days of the event.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{d.customer.name}</span>
            <span>TRN {d.customer.trn ?? "not registered"}</span>
            {[d.customer.address_line1, d.customer.address_line2, d.customer.city, d.customer.emirate]
              .filter(Boolean)
              .map((x) => (
                <span key={x}>{x}</span>
              ))}
            <Link className="underline" href={`/accounting/statements?customer=${d.customer.id}`}>
              Statement
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Document</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-1 text-sm">
            <span className="text-muted-foreground">Date</span>
            <span>{d.invoice_date}</span>
            {d.supply_date && (
              <>
                <span className="text-muted-foreground">Date of supply</span>
                <span>{d.supply_date}</span>
              </>
            )}
            {!credit && (
              <>
                <span className="text-muted-foreground">Due</span>
                <span>{d.due_date ?? "On issue, from the credit terms"}</span>
              </>
            )}
            {credit && d.original && (
              <>
                <span className="text-muted-foreground">Credits</span>
                <Link className="underline" href={`/accounting/sales-invoices/${d.original.id}`}>
                  {d.original.number}
                </Link>
                <span className="text-muted-foreground">Event</span>
                <span>{d.event_date ?? "-"}</span>
                <span className="text-muted-foreground">Reason</span>
                <span>{d.credit_reason ?? "-"}</span>
              </>
            )}
            {d.reference && (
              <>
                <span className="text-muted-foreground">Reference</span>
                <span>{d.reference}</span>
              </>
            )}
            {d.invoice_form && (
              <>
                <span className="text-muted-foreground">Form</span>
                <span>{d.invoice_form === "full" ? "Full tax invoice" : "Simplified tax invoice"}</span>
              </>
            )}
            <span className="text-muted-foreground">Ledger</span>
            <span>
              {d.journal ? (
                <Link className="underline" href={`/accounting/journals/${d.journal.id}`}>
                  {d.journal.number}
                </Link>
              ) : (
                POSTING_STATUS_LABELS[d.posting_status]
              )}
            </span>
            <span className="text-muted-foreground">E-invoice</span>
            <span>{d.einvoice_status === "not_applicable" ? "Not sent (not wired yet)" : d.einvoice_status}</span>
            <span className="text-muted-foreground">Prepared by</span>
            <span>{d.people.prepared}</span>
            {d.status !== "draft" && (
              <>
                <span className="text-muted-foreground">Issued by</span>
                <span>
                  {d.people.issued}
                  {d.approval_required && (
                    <Badge variant="outline" className="ml-2">
                      approved
                    </Badge>
                  )}
                </span>
              </>
            )}
            {d.status === "void" && d.void_reason && (
              <>
                <span className="text-muted-foreground">Voided</span>
                <span>
                  {d.people.voided}: {d.void_reason}
                </span>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>VAT</TableHead>
                <TableHead className="text-right">VAT AED</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lines.map((l) => (
                <TableRow key={l.line_no}>
                  <TableCell>{l.line_no}</TableCell>
                  <TableCell className="max-w-72">{l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.discount ? money(l.discount) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.net)}</TableCell>
                  <TableCell className="text-xs">
                    {l.tax_code} {l.vat_rate}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.vat_amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.line_total)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {l.income_account}
                    {l.branch_code ? ` / ${l.branch_code}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-col items-end gap-1 text-sm tabular-nums">
            <span>Subtotal {money(d.subtotal)}</span>
            {d.discount_total > 0 && <span>Discount {money(d.discount_total)}</span>}
            <span>Net {money(d.net_total)}</span>
            {vat.map((r) => (
              <span key={r.rate}>
                VAT {r.rate}% on {money(r.net)}: {money(r.vat)}
              </span>
            ))}
            <span className="text-base font-semibold">Total AED {money(d.total)}</span>
            {!credit && d.status !== "draft" && (
              <>
                {d.amount_credited > 0 && <span>Credited {money(d.amount_credited)}</span>}
                {d.amount_paid > 0 && <span>Received {money(d.amount_paid)}</span>}
                {d.status !== "void" && <span className="font-medium">Open {money(open)}</span>}
              </>
            )}
          </div>
          {d.content_sha256 && (
            <p className="text-muted-foreground mt-3 font-mono text-[11px] break-all">
              content sha256 {d.content_sha256}
            </p>
          )}
        </CardContent>
      </Card>

      {!credit && (d.creditNotes.length > 0 || d.allocations.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credit notes and receipts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {d.creditNotes.map((c) => (
              <Link key={c.id} className="underline" href={`/accounting/sales-invoices/${c.id}`}>
                {c.number ?? "Draft credit note"}, {c.invoice_date}, {money(c.total)}
              </Link>
            ))}
            {d.allocations.map((a) => (
              <Link key={a.receipt_id} className="underline" href={`/accounting/receipts/${a.receipt_id}`}>
                Receipt {a.number}, {a.receipt_date}, {money(a.amount)}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
      {d.notes && <p className="text-muted-foreground text-sm">Notes: {d.notes}</p>}
    </div>
  );
}
