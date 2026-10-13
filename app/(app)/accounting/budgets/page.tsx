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
import { defaultStartMonth, loadEntities, peopleNames } from "@/lib/accounting/accounting-server";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { BUDGET_VIEW_KEYS, loadBudgets } from "@/lib/accounting/statements/server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

import { BudgetHeaderButton } from "./forms";

export const metadata = { title: "Budgets" };
export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const member = await requireMember();
  if (!canAny(member, BUDGET_VIEW_KEYS)) throw new ForbiddenError("accounting.budgets.manage");
  const manage = can(member, "accounting.budgets.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [entities, budgets] = await Promise.all([
    loadEntities(admin, member.orgId),
    loadBudgets(admin, member.orgId),
  ]);
  const people = await peopleNames(
    admin,
    budgets.flatMap((b) => [b.prepared_by, b.approved_by]),
  );
  const today = todayIn(member.org.timezone);
  const sm = defaultStartMonth(entities);
  const cur = fiscalYearOf(sm, today);
  const shift = (iso: string, days: number) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const years = [
    fiscalYearOf(sm, shift(cur.end, 1)),
    cur,
    fiscalYearOf(sm, shift(cur.start, -1)),
  ].map((y) => ({
    start: y.start,
    label: y.label,
  }));
  const entityName = new Map(entities.map((e) => [e.id, e.name]));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Budgets"
        description="Monthly budgets per income and expense ledger (optionally per branch or department). The Accountant prepares; the Finance Manager or Chief Accountant approves. Compare them under Reports, Budget against actual."
      >
        {manage && (
          <BudgetHeaderButton
            years={years}
            entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          />
        )}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Fiscal year</TableHead>
                {entities.length > 1 && <TableHead>Entity</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead>Prepared by</TableHead>
                <TableHead>Approved by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {budgets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    No budgets yet.
                  </TableCell>
                </TableRow>
              )}
              {budgets.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link
                      href={`/accounting/budgets/${b.id}`}
                      className="font-medium hover:underline"
                    >
                      {b.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {fiscalYearOf(Number(b.fy_start.slice(5, 7)), b.fy_start).label}
                  </TableCell>
                  {entities.length > 1 && (
                    <TableCell>{entityName.get(b.entity_id) ?? ""}</TableCell>
                  )}
                  <TableCell>
                    {b.status === "approved" ? (
                      <Badge variant="success">Approved</Badge>
                    ) : (
                      <Badge variant="outline">Draft</Badge>
                    )}
                  </TableCell>
                  <TableCell>{(b.prepared_by && people.get(b.prepared_by)) ?? ""}</TableCell>
                  <TableCell>{(b.approved_by && people.get(b.approved_by)) ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
