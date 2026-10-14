import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Term } from "@/components/shell/term";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadBranchCodeOptions } from "@/lib/accounting/accounting-server";
import { loadAgeing } from "@/lib/accounting/receivables-server";
import { AGEING_BUCKETS, CUSTOMER_KIND_LABELS } from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { pickBranchCode } from "@/lib/branches/codes";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { BranchCodeSelect, dateParam } from "../ui";

export const metadata = { title: "Receivables ageing" };
export const dynamic = "force-dynamic";

export default async function ReceivablesAgeingPage({
  searchParams,
}: {
  searchParams: Promise<{ as_of?: string; branch?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.reports.view");
  const sp = await searchParams;
  const asOf = dateParam(sp.as_of, new Date().toISOString().slice(0, 10));
  const admin = createAdminClient(); // service role AFTER the permission check
  // Phase B: one branch's invoices (a line naming its finance code); money on account names no branch.
  const branchOptions = await loadBranchCodeOptions(admin, member.orgId);
  const branch = pickBranchCode(sp.branch, branchOptions);
  const a = await loadAgeing(admin, member.orgId, asOf, branch);
  await recordAccess(admin, member, { entity: "accounting_receivable", action: "list" });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Receivables ageing"
        description={
          <>
            What each customer owes on Pulse&apos;s own sales invoices, by days past the due date.
            Money received but not yet allocated shows as on account. Insurance claims from Unite are
            aged in{" "}
            {can(member, "finance.claims.view") ? (
              <Link href="/finance/receivables" className="underline">
                Finance, Insurance and receivables, By payer and age
              </Link>
            ) : (
              "Finance"
            )}
            .
          </>
        }
      />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">As at</span>
          <Input type="date" name="as_of" defaultValue={asOf} className="w-40" />
        </label>
        <BranchCodeSelect options={branchOptions} value={branch} />
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {branch && (
        <p className="text-muted-foreground text-sm">
          Branch {branch}: invoices with a line for this branch, at their full open amount. Money on account names no
          branch and is not shown.
        </p>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                {AGEING_BUCKETS.map((b) => (
                  <TableHead key={b.key} className="text-right">
                    {b.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">
                  <Term k="on-account" />
                </TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={AGEING_BUCKETS.length + 3} className="text-muted-foreground text-sm">
                    Nothing is owed as at {asOf}.
                  </TableCell>
                </TableRow>
              ) : (
                a.rows.map((r) => (
                  <TableRow key={r.customerId}>
                    <TableCell>
                      <Link
                        className="underline"
                        href={`/accounting/statements?customer=${r.customerId}&to=${asOf}`}
                      >
                        {r.name}
                      </Link>
                      <span className="text-muted-foreground ml-2 text-xs">{CUSTOMER_KIND_LABELS[r.kind]}</span>
                    </TableCell>
                    {AGEING_BUCKETS.map((b) => (
                      <TableCell key={b.key} className="text-right tabular-nums">
                        {r.buckets[b.key] ? money(r.buckets[b.key]) : ""}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">{r.onAccount ? money(r.onAccount) : ""}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(r.total)}</TableCell>
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
                  <TableCell className="text-right tabular-nums">{money(a.totals.onAccount)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{money(a.totals.total)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
