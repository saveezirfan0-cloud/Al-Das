import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canAny, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { currentMonth, monthsAgo } from "@/lib/finance/summary";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

import { CostUpload, MonthButton } from "./cost-forms";

export const metadata = { title: "Costs" };
export const dynamic = "force-dynamic";

const PERMS = ["finance.costs.manage", "finance.costs.view", "finance.costs.compensation"] as const;
const LIMIT = 40;

export default async function CostsPage() {
  const member = await requireMember();
  if (!canAny(member, PERMS)) redirect("/dashboard");
  const canManage = can(member, "finance.costs.manage");
  const canView = canManage || can(member, "finance.costs.view");
  const canComp = can(member, "finance.costs.compensation");
  const canApprove = can(member, "finance.profit.approve");
  // The member's own client: row level security decides what each table returns.
  const supabase = await createClient();
  const [services, overheads, comp, periods] = await Promise.all([
    canView
      ? supabase
          .from("fin_cost_services")
          .select("item_code, effective_from, unit_cost, note", { count: "exact" })
          .order("effective_from", { ascending: false })
          .order("item_code")
          .limit(LIMIT)
      : null,
    canView
      ? supabase
          .from("fin_cost_overheads")
          .select("month, branch_code, pool, amount, basis", { count: "exact" })
          .order("month", { ascending: false })
          .limit(LIMIT)
      : null,
    canComp
      ? supabase
          .from("fin_cost_doctor_comp")
          .select("month, doctor_dha_id, amount", { count: "exact" })
          .order("month", { ascending: false })
          .limit(LIMIT)
      : null,
    supabase.from("fin_cost_periods").select("month, status, approved_at"),
  ]);
  const status = new Map(
    (periods.data ?? []).map((p) => [p.month, p.status as "draft" | "approved"]),
  );
  const months = Array.from({ length: 6 }, (_, i) => `${monthsAgo(i)}-01`);
  for (const m of status.keys()) if (!months.includes(m)) months.push(m);
  months.sort().reverse();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Costs"
        description="The cost inputs behind contribution margin and profitability. Maintained by Finance; Unite's own cost price is 0, which means unavailable, not free."
      />
      <Alert>
        <AlertTitle>How this works</AlertTitle>
        <AlertDescription>
          Upload a CSV for each kind of cost. A file is saved whole or not at all, and a row with a
          problem is named so you can fix it. Profit figures stay provisional until a month is
          approved below. {currentMonth()} is the current month.
        </AlertDescription>
      </Alert>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Service costs</CardTitle>
            <CardDescription>
              The cost of one unit of a service, by Unite item code, from a date. The latest row on
              or before the invoice date applies. A cost of 0 is refused: leave the row out instead.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CostUpload kind="services" />
            <CostTable
              empty="No service costs yet. Every service line counts as uncosted until you load them."
              head={["Item code", "From", "Unit cost"]}
              rows={(services?.data ?? []).map((r) => [
                r.item_code,
                r.effective_from,
                money(r.unit_cost),
              ])}
              total={services?.count ?? 0}
            />
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overheads</CardTitle>
            <CardDescription>
              Operating costs by month. Leave the branch blank for a shared cost; it is split across
              branches by revenue, by invoice lines, or equally (the basis column).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CostUpload kind="overheads" />
            <CostTable
              empty="No overheads yet. Estimated profitability needs them."
              head={["Month", "Branch", "Pool", "Amount", "Basis"]}
              rows={(overheads?.data ?? []).map((r) => [
                r.month.slice(0, 7),
                r.branch_code ?? "Shared",
                r.pool,
                money(r.amount),
                r.branch_code ? "—" : r.basis,
              ])}
              total={overheads?.count ?? 0}
            />
          </CardContent>
        </Card>
      )}

      {canComp && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doctor compensation</CardTitle>
            <CardDescription>
              Confidential. Visible only to people holding the doctor compensation permission. Use
              the doctor&apos;s DHA licence id, one row per doctor and month.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CostUpload kind="compensation" />
            <CostTable
              empty="No compensation loaded yet."
              head={["Month", "Doctor (DHA id)", "Amount"]}
              rows={(comp?.data ?? []).map((r) => [
                r.month.slice(0, 7),
                r.doctor_dha_id,
                money(r.amount),
              ])}
              total={comp?.count ?? 0}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Months</CardTitle>
          <CardDescription>
            Approving a month says its costs are complete. Approved months cannot have compensation
            or overheads changed until they are reopened (which is audited).
            {!canApprove && " You do not hold the approval permission."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => {
                const s = status.get(m) ?? "draft";
                return (
                  <TableRow key={m}>
                    <TableCell className="text-sm">{m.slice(0, 7)}</TableCell>
                    <TableCell>
                      <Badge variant={s === "approved" ? "success" : "warning"}>
                        {s === "approved" ? "Approved" : "Draft"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canApprove && <MonthButton month={m} status={s} />}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function CostTable({
  head,
  rows,
  total,
  empty,
}: {
  head: string[];
  rows: string[][];
  total: number;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {head.map((h, i) => (
                <TableHead
                  key={h}
                  className={
                    i === head.length - 1 && /amount|cost/i.test(h) ? "text-right" : undefined
                  }
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((c, j) => (
                  <TableCell
                    key={j}
                    className={`text-xs ${/^[\d,]+\.\d{2}$/.test(c) ? "text-right tabular-nums" : ""}`}
                  >
                    {c}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {total > rows.length && (
        <p className="text-muted-foreground text-xs">
          Showing the latest {rows.length} of {total.toLocaleString()}.
        </p>
      )}
    </div>
  );
}
