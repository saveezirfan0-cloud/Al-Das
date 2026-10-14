import Link from "next/link";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
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
import { PAYABLES_READ } from "@/lib/accounting/nav";
import { loadSupplierStatement, loadSuppliers } from "@/lib/accounting/payables-server";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam, RangeForm } from "../ui";

export const metadata = { title: "Supplier statements" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT =
  "border-input bg-background h-9 w-64 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring";

export default async function SupplierStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ supplier?: string; from?: string; to?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, PAYABLES_READ)) throw new ForbiddenError("accounting.reports.view");
  const sp = await searchParams;
  const to = dateParam(sp.to, todayIn(member.org.timezone));
  const from = dateParam(sp.from, `${to.slice(0, 4)}-01-01`);
  const supplierId = UUID.test(sp.supplier ?? "") ? sp.supplier! : null;
  const admin = createAdminClient(); // service role AFTER the permission check
  const suppliers = await loadSuppliers(admin, member.orgId);
  const s =
    supplierId && from <= to
      ? await loadSupplierStatement(admin, member.orgId, supplierId, from, to)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Supplier statements"
        description="A supplier's invoices and the payments made to them, with the running balance the clinic owes. Compare it with the statement the supplier sends."
      >
        {s && (
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/accounting/supplier-statements?supplier=${s.supplier.id}&from=${from}&to=${to}`}
            >
              <Download aria-hidden /> Excel
            </a>
          </Button>
        )}
      </PageHeader>
      <RangeForm from={from} to={to}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Supplier</span>
          <select name="supplier" defaultValue={supplierId ?? ""} className={SELECT}>
            <option value="">Choose a supplier</option>
            {suppliers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      </RangeForm>
      {from > to && (
        <p className="text-destructive text-sm">The start date is after the end date.</p>
      )}
      {s && (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead className="text-right">Billed</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Owed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>{from}</TableCell>
                  <TableCell colSpan={3}>Opening balance</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.opening)}</TableCell>
                </TableRow>
                {s.rows.map((r, i) => (
                  <TableRow key={`${r.kind}-${r.number}-${i}`}>
                    <TableCell className="whitespace-nowrap">{r.date}</TableCell>
                    <TableCell>
                      {r.kind === "invoice" ? "Invoice" : "Payment"}{" "}
                      <span className="font-mono text-xs">{r.number}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.credit ? money(r.credit) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.debit ? money(r.debit) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.balance)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>{to}</TableCell>
                  <TableCell className="font-medium">Closing balance</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.billed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.paid)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {money(s.closing)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p className="text-muted-foreground mt-3 text-xs">
              A positive balance is owed to the supplier; a negative one was paid in advance.
              Payments are the paid vouchers&apos; amounts on their payment date.
              {s.otherCurrency > 0
                ? ` ${s.otherCurrency} item(s) in another currency are not included.`
                : ""}{" "}
              <Link className="underline" href={`/accounting/payables-ageing?as_of=${to}`}>
                Payables ageing
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
