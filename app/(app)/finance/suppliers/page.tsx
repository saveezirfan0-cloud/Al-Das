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
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { SupplierButton } from "../payables/forms";

export const metadata = { title: "Suppliers" };
export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const member = await requireMember();
  if (!canAny(member, ["finance.payables.view", "finance.payables.manage"]))
    throw new ForbiddenError("finance.payables.view");
  const manage = can(member, "finance.payables.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: suppliers }, { data: open }] = await Promise.all([
    admin
      .from("fin_suppliers")
      .select("id, name, trn, default_category, payment_terms_days, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("fin_supplier_invoices")
      .select("supplier_id, total")
      .eq("org_id", member.orgId)
      .in("status", ["open", "on_voucher"]),
  ]);
  const outstanding = new Map<string, { n: number; total: number }>();
  for (const i of open ?? []) {
    const cur = outstanding.get(i.supplier_id) ?? { n: 0, total: 0 };
    outstanding.set(i.supplier_id, { n: cur.n + 1, total: cur.total + Number(i.total) });
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Suppliers"
        description="Who the clinic pays. Bank details are not kept in Pulse; they stay with the bank and Tally."
      >
        {manage && <SupplierButton />}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>TRN</TableHead>
                <TableHead>Default category</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead className="text-right">Unpaid invoices</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(suppliers ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    No suppliers yet.
                  </TableCell>
                </TableRow>
              ) : (
                (suppliers ?? []).map((s) => {
                  const o = outstanding.get(s.id);
                  return (
                    <TableRow key={s.id} className={s.active ? "" : "opacity-60"}>
                      <TableCell>
                        {s.name}
                        {!s.active && (
                          <Badge variant="secondary" className="ml-2">
                            inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{s.trn ?? "-"}</TableCell>
                      <TableCell>{s.default_category ?? "-"}</TableCell>
                      <TableCell>
                        {s.payment_terms_days === null ? "-" : `${s.payment_terms_days} days`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {o
                          ? `${o.n} (AED ${o.total.toLocaleString("en-GB", { minimumFractionDigits: 2 })})`
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {manage && <SupplierButton supplier={s} />}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
