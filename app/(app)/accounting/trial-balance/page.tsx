import { selectClass } from "@/components/finance/forms";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  defaultStartMonth,
  loadAccounts,
  loadEntities,
  loadTrialBalance,
} from "@/lib/accounting/accounting-server";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { buildTrialBalance, rangeProblem } from "@/lib/accounting/reports";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance, dateParam, RangeForm } from "../ui";

export const metadata = { title: "Trial balance" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; entity?: string; view?: string };

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("accounting.reports.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const [entities, accounts] = await Promise.all([
    loadEntities(admin, member.orgId),
    loadAccounts(admin, member.orgId),
  ]);
  const entity = entities.find((e) => e.id === sp.entity) ?? null;
  const fy = fiscalYearOf(entity?.fiscal_year_start_month ?? defaultStartMonth(entities), today);
  let from = dateParam(sp.from, fy.start);
  let to = dateParam(sp.to, today);
  const problem = rangeProblem(from, to);
  if (problem) {
    from = fy.start;
    to = today;
  }
  const groupsOnly = sp.view === "groups";
  const data = await loadTrialBalance(admin, member.orgId, entity?.id ?? null, from, to);
  const tb = buildTrialBalance(accounts, data, { groupsOnly });
  const exportHref = `/api/accounting/trial-balance?from=${from}&to=${to}${entity ? `&entity=${entity.id}` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Trial balance"
        description={`Every account's opening balance, movements and closing balance. Income and expense accounts start again each fiscal year (${fy.label} runs ${fy.start} to ${fy.end}).`}
      >
        <Button asChild variant="outline" size="sm">
          <a href={exportHref}>Download Excel</a>
        </Button>
      </PageHeader>
      <RangeForm from={from} to={to}>
        {entities.length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Entity</span>
            <select name="entity" defaultValue={entity?.id ?? ""} className={`${selectClass} w-48`}>
              <option value="">All entities</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Show</span>
          <select
            name="view"
            defaultValue={groupsOnly ? "groups" : ""}
            className={`${selectClass} w-40`}
          >
            <option value="">Groups and ledgers</option>
            <option value="groups">Groups only</option>
          </select>
        </label>
      </RangeForm>
      {problem && (
        <Alert>
          <AlertDescription>{problem} Showing the fiscal year to date instead.</AlertDescription>
        </Alert>
      )}
      <div>
        {tb.balanced ? (
          <Badge variant="success">Balanced</Badge>
        ) : (
          <Badge variant="destructive">Out of balance: report this to the administrator</Badge>
        )}
      </div>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tb.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    Nothing posted up to this date.
                  </TableCell>
                </TableRow>
              )}
              {tb.lines.map((l) => (
                <TableRow key={l.id} className={l.isGroup ? "font-medium" : ""}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{l.code}</TableCell>
                  <TableCell>
                    <span style={{ paddingLeft: `${l.depth * 1.25}rem` }}>{l.name}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Balance value={l.opening} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.credit)}</TableCell>
                  <TableCell className="text-right">
                    <Balance value={l.closing} />
                  </TableCell>
                </TableRow>
              ))}
              {tb.earlierYearsPl !== 0 && (
                <TableRow>
                  <TableCell />
                  <TableCell>Profit or loss of earlier years (not yet closed)</TableCell>
                  <TableCell className="text-right">
                    <Balance value={tb.earlierYearsPl} />
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right">
                    <Balance value={tb.earlierYearsPl} />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Total</TableCell>
                <TableCell className="text-right">
                  <Balance value={tb.totals.opening} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(tb.totals.debit)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(tb.totals.credit)}</TableCell>
                <TableCell className="text-right">
                  <Balance value={tb.totals.closing} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
