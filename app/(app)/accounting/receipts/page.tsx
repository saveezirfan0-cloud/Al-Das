import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { selectClass } from "@/components/finance/forms";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import {
  loadCustomers,
  loadReceiptList,
  SALES_LIST_LIMIT,
} from "@/lib/accounting/receivables-server";
import { RECEIPT_MODE_LABELS, type ReceiptMode } from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { RetryPostings } from "../sales-invoices/controls";
import { dateParam, RangeForm } from "../ui";

export const metadata = { title: "Receipts" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; from?: string; to?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.receipts.manage");
  const sp = await searchParams;
  const customerId = UUID.test(sp.customer ?? "") ? sp.customer! : null;
  const from = sp.from ? dateParam(sp.from, "") || null : null;
  const to = sp.to ? dateParam(sp.to, "") || null : null;
  const admin = createAdminClient(); // service role AFTER the permission check
  const [rows, customers] = await Promise.all([
    loadReceiptList(admin, member.orgId, { customerId, from, to }),
    loadCustomers(admin, member.orgId),
  ]);
  await recordAccess(admin, member, { entity: "accounting_receivable", action: "list" });
  const manage = can(member, "accounting.receipts.manage");
  const waiting = rows.some((r) => r.posting_status === "waiting_ledger_start");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Receipts"
        description="Money received from customers, allocated to their invoices. Insurance remittances are matched in Finance, Remittances, not here."
      >
        {manage && (
          <Button asChild>
            <Link href="/accounting/receipts/new">New receipt</Link>
          </Button>
        )}
      </PageHeader>
      <RangeForm from={from ?? ""} to={to ?? ""}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Customer</span>
          <select name="customer" defaultValue={customerId ?? ""} className={`${selectClass} w-56`}>
            <option value="">Any customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </RangeForm>
      {waiting && manage && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          <span>Some receipts are dated before the ledger start and wait (Tally holds those dates).</span>
          <RetryPostings />
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">On account</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState title="No receipts match" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id} className={r.status === "void" ? "opacity-60" : ""}>
                    <TableCell className="whitespace-nowrap">{r.receipt_date}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <Link className="underline" href={`/accounting/receipts/${r.id}`}>
                        {r.number}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{r.customer}</TableCell>
                    <TableCell>{RECEIPT_MODE_LABELS[r.mode as ReceiptMode] ?? r.mode}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.status === "void" ? "" : money(r.amount - r.amount_allocated)}
                    </TableCell>
                    <TableCell>
                      {r.status === "void" && <Badge variant="secondary">Void</Badge>}
                      {r.posting_status === "waiting_ledger_start" && (
                        <span className="text-muted-foreground ml-2 text-xs">in Tally</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {rows.length === SALES_LIST_LIMIT && (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing the latest {SALES_LIST_LIMIT}. Narrow the dates to see more.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
