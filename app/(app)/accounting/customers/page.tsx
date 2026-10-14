import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadCustomerOptions, loadCustomers } from "@/lib/accounting/receivables-server";
import { CUSTOMER_KIND_LABELS } from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { CustomerButton } from "./forms";

export const metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.sales.manage");
  const manage = can(member, "accounting.sales.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [customers, options] = await Promise.all([
    loadCustomers(admin, member.orgId),
    loadCustomerOptions(admin, member.orgId),
  ]);
  await recordAccess(admin, member, { entity: "accounting_receivable", action: "list" });
  const payerName = new Map(options.payers.map((p) => [p.id, p.label]));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Customers"
        description="The businesses Pulse invoices: insurers (linked to their payer), corporates, tenants and others. Patients are invoiced in Unite."
      >
        {manage && <CustomerButton payers={options.payers} receivableAccounts={options.receivableAccounts} />}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>TRN</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead>Payer</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    No customers yet.
                  </TableCell>
                </TableRow>
              )}
              {customers.map((c) => (
                <TableRow key={c.id} className={c.active ? "" : "opacity-60"}>
                  <TableCell>
                    <Link className="underline" href={`/accounting/statements?customer=${c.id}`}>
                      {c.name}
                    </Link>
                    {!c.active && (
                      <Badge variant="secondary" className="ml-2">
                        inactive
                      </Badge>
                    )}
                    {c.connected_person && (
                      <Badge variant="outline" className="ml-2">
                        connected
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{CUSTOMER_KIND_LABELS[c.kind]}</TableCell>
                  <TableCell className="font-mono text-xs">{c.trn ?? "Not registered"}</TableCell>
                  <TableCell>{c.credit_terms_days} days</TableCell>
                  <TableCell className="text-xs">
                    {c.payer_id ? (payerName.get(c.payer_id) ?? c.payer_id) : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    {manage && (
                      <CustomerButton
                        customer={c}
                        payers={options.payers}
                        receivableAccounts={options.receivableAccounts}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
