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
import { loadEntities, peopleNames } from "@/lib/accounting/accounting-server";
import { periodLabel } from "@/lib/accounting/numbering";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { nameOf } from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { CreatePeriodButton, PeriodButtons } from "./controls";

export const metadata = { title: "Periods" };
export const dynamic = "force-dynamic";

export default async function PeriodsPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.periods.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.periods.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [entities, { data: periods }, { data: years }] = await Promise.all([
    loadEntities(admin, member.orgId),
    admin
      .from("acc_periods")
      .select(
        "id, entity_id, fiscal_year_id, year, month, is_adjustment, start_date, status, closed_by, closed_at, locked_by, locked_at",
      )
      .eq("org_id", member.orgId)
      .order("start_date", { ascending: false })
      .order("month", { ascending: false })
      .limit(120),
    admin.from("acc_fiscal_years").select("id, label").eq("org_id", member.orgId),
  ]);
  const fyLabel = new Map((years ?? []).map((y) => [y.id, y.label]));
  const entityName = new Map(entities.map((e) => [e.id, e.name]));
  const people = await peopleNames(
    admin,
    (periods ?? []).flatMap((p) => [p.closed_by, p.locked_by]),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Periods"
        description="One period per month, created by the first posting in it, plus each fiscal year's adjustment period. A closed period takes postings only from people who manage periods; a locked period takes none, ever. A month the CEO signed off in Finance refuses postings too."
      >
        {manage && (
          <CreatePeriodButton
            entities={entities.map((e) => ({ id: e.id, name: e.name }))}
            today={todayIn(member.org.timezone)}
          />
        )}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Fiscal year</TableHead>
                {entities.length > 1 && <TableHead>Entity</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead>Changed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(periods ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    No periods yet. The first posting creates its month.
                  </TableCell>
                </TableRow>
              )}
              {(periods ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {periodLabel(p.year, p.month, fyLabel.get(p.fiscal_year_id))}
                  </TableCell>
                  <TableCell>{fyLabel.get(p.fiscal_year_id) ?? ""}</TableCell>
                  {entities.length > 1 && <TableCell>{entityName.get(p.entity_id)}</TableCell>}
                  <TableCell>
                    <Badge
                      variant={
                        p.status === "open"
                          ? "success"
                          : p.status === "closed"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {p.status === "locked" && p.locked_at
                      ? `Locked ${p.locked_at.slice(0, 10)} by ${nameOf(people, p.locked_by)}`
                      : p.status === "closed" && p.closed_at
                        ? `Closed ${p.closed_at.slice(0, 10)} by ${nameOf(people, p.closed_by)}`
                        : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    {manage && <PeriodButtons id={p.id} status={p.status} />}
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
