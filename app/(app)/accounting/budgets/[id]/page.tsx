import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAccounts, loadEntities, peopleNames } from "@/lib/accounting/accounting-server";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { fiscalMonths } from "@/lib/accounting/statements/budget";
import { BUDGET_VIEW_KEYS, loadBudget } from "@/lib/accounting/statements/server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  BudgetActions,
  BudgetCsvImport,
  BudgetGrid,
  BudgetHeaderButton,
  type GridAccount,
} from "../forms";

export const metadata = { title: "Budget" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  if (!canAny(member, BUDGET_VIEW_KEYS)) throw new ForbiddenError("accounting.budgets.manage");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const [budget, accounts, entities] = await Promise.all([
    loadBudget(admin, member.orgId, id),
    loadAccounts(admin, member.orgId),
    loadEntities(admin, member.orgId),
  ]);
  if (!budget) notFound();
  const manage = can(member, "accounting.budgets.manage");
  const approve = can(member, "accounting.journals.approve");
  const people = await peopleNames(admin, [budget.prepared_by, budget.approved_by]);
  const months = fiscalMonths(budget.fy_start);
  const used = new Set(budget.lines.map((l) => l.account_id));
  const grid: GridAccount[] = accounts
    .filter(
      (a) =>
        !a.is_group &&
        (a.nature === "income" || a.nature === "expense") &&
        (a.is_active || used.has(a.id)) &&
        (a.entity_id === null || a.entity_id === budget.entity_id),
    )
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      nature: a.nature as "income" | "expense",
    }));
  const initial: Record<string, number> = {};
  const dimensional = budget.lines.filter((l) => l.branch_code || l.department);
  for (const l of budget.lines)
    if (!l.branch_code && !l.department) initial[`${l.account_id}|${l.month}`] = l.amount;
  const editable = manage && budget.status === "draft";
  const fy = fiscalYearOf(Number(budget.fy_start.slice(5, 7)), budget.fy_start);
  const total = (nature: string) =>
    budget.lines
      .filter((l) => accounts.find((a) => a.id === l.account_id)?.nature === nature)
      .reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100;
  const selfPrepared = budget.prepared_by === member.userId;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={budget.name}
        description={`${fy.label}${entities.length > 1 ? `, ${entities.find((e) => e.id === budget.entity_id)?.name ?? ""}` : ""}. Income ${money(total("income"))}, expenses ${money(total("expense"))}.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/accounting/reports/budget-vs-actual?budget=${budget.id}`}>
              Budget against actual
            </Link>
          </Button>
          {editable && (
            <BudgetHeaderButton
              budget={{
                id: budget.id,
                name: budget.name,
                fy_start: budget.fy_start,
                entity_id: budget.entity_id,
              }}
              years={[]}
              entities={[]}
            />
          )}
        </div>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {budget.status === "approved" ? (
              <Badge variant="success">Approved</Badge>
            ) : (
              <Badge variant="outline">Draft</Badge>
            )}
            <span className="text-muted-foreground text-sm font-normal">
              Prepared by{" "}
              {(budget.prepared_by && people.get(budget.prepared_by)) || "someone no longer here"}
              {budget.approved_by &&
                `, approved by ${people.get(budget.approved_by) ?? "someone no longer here"} on ${budget.approved_at?.slice(0, 10)}`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground font-mono text-xs break-all">
            Fingerprint (sha256):{" "}
            {budget.status === "approved" ? budget.approved_sha256 : budget.hash}
          </p>
          {budget.status === "draft" && approve && selfPrepared && (
            <p className="text-muted-foreground">
              You prepared this budget, so someone else approves it.
            </p>
          )}
          <BudgetActions
            id={budget.id}
            status={budget.status}
            hash={budget.hash}
            canApprove={approve && !selfPrepared && budget.lines.length > 0}
            canManage={manage}
          />
          {editable && <BudgetCsvImport budgetId={budget.id} />}
          {editable && (
            <p className="text-muted-foreground text-xs">
              CSV columns: account_code, month (yyyy-mm), amount, and optionally branch_code and
              department. Importing replaces every line of the budget.
            </p>
          )}
        </CardContent>
      </Card>
      <BudgetGrid
        budgetId={budget.id}
        accounts={grid}
        months={months}
        initial={initial}
        editable={editable}
      />
      {dimensional.length > 0 && (
        <p className="text-muted-foreground text-sm">
          {dimensional.length} line(s) carry a branch or department (from a CSV). The grid shows the
          whole-entity lines; those lines are kept as they are when the grid is saved and count in
          Budget against actual.
        </p>
      )}
    </div>
  );
}
