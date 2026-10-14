import Link from "next/link";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PAYABLES_READ } from "@/lib/accounting/nav";
import { loadPayablesAgeing } from "@/lib/accounting/payables-server";
import { AGEING_BUCKETS } from "@/lib/accounting/sales";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam } from "../ui";

export const metadata = { title: "Payables ageing" };
export const dynamic = "force-dynamic";

const OVERDUE_LIST = 50;

export default async function PayablesAgeingPage({
  searchParams,
}: {
  searchParams: Promise<{ as_of?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, PAYABLES_READ)) throw new ForbiddenError("accounting.reports.view");
  const sp = await searchParams;
  const asOf = dateParam(sp.as_of, todayIn(member.org.timezone));
  const admin = createAdminClient(); // service role AFTER the permission check
  const a = await loadPayablesAgeing(admin, member.orgId, asOf);
  const overdue = a.open.filter((o) => o.daysOverdue > 0).slice(0, OVERDUE_LIST);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Payables ageing"
        description="What the clinic owes each supplier on the supplier invoices in Finance, by days past the due date, as at a date. An invoice counts as paid once its payment voucher is paid; vouchers paid to a supplier without an invoice show as paid on account."
      >
        <Button asChild variant="outline" size="sm">
          <a href={`/api/accounting/payables-ageing?as_of=${asOf}`}>
            <Download aria-hidden /> Excel
          </a>
        </Button>
      </PageHeader>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">As at</span>
          <Input type="date" name="as_of" defaultValue={asOf} className="w-40" />
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {a.otherCurrency > 0 && (
        <p className="text-muted-foreground text-sm">
          {a.otherCurrency} item(s) in a currency other than AED are left out of these totals.
        </p>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                {AGEING_BUCKETS.map((b) => (
                  <TableHead key={b.key} className="text-right">
                    {b.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Paid on account</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={AGEING_BUCKETS.length + 3}
                    className="text-muted-foreground text-sm"
                  >
                    Nothing is owed to suppliers as at {asOf}.
                  </TableCell>
                </TableRow>
              ) : (
                a.rows.map((r) => (
                  <TableRow key={r.supplierId}>
                    <TableCell>
                      <Link
                        className="underline"
                        href={`/accounting/supplier-statements?supplier=${r.supplierId}&to=${asOf}`}
                      >
                        {r.name}
                      </Link>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {r.openInvoices} open
                      </span>
                    </TableCell>
                    {AGEING_BUCKETS.map((b) => (
                      <TableCell key={b.key} className="text-right tabular-nums">
                        {r.buckets[b.key] ? money(r.buckets[b.key]) : ""}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      {r.onAccount ? money(r.onAccount) : ""}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money(r.total)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {a.rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">Total</TableCell>
                  {AGEING_BUCKETS.map((b) => (
                    <TableCell key={b.key} className="text-right tabular-nums">
                      {money(a.totals.buckets[b.key])}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">
                    {money(a.totals.onAccount)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {money(a.totals.total)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
      {overdue.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Most overdue invoices</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Dated</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Days overdue</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overdue.map((o) => (
                  <TableRow key={o.invoiceId}>
                    <TableCell>
                      {a.rows.find((r) => r.supplierId === o.supplierId)?.name ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{o.number}</TableCell>
                    <TableCell className="whitespace-nowrap">{o.invoiceDate}</TableCell>
                    <TableCell className="whitespace-nowrap">{o.dueDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.daysOverdue}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(o.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-muted-foreground mt-3 text-xs">
              The {OVERDUE_LIST} oldest at most; the Excel download lists every open invoice. Pay
              them with a voucher under{" "}
              <Link className="underline" href="/finance/payables">
                Finance, Supplier invoices
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
