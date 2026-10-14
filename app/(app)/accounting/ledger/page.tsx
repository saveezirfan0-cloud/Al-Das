import Link from "next/link";

import { selectClass } from "@/components/finance/forms";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  loadBranchCodeOptions,
  loadEntities,
  loadLedger,
} from "@/lib/accounting/accounting-server";
import { flattenTree } from "@/lib/accounting/accounts";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { rangeProblem } from "@/lib/accounting/reports";
import { requirePerm } from "@/lib/auth/session";
import { pickBranchCode } from "@/lib/branches/codes";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { Amount, Balance, BRANCH_VIEW_NOTE, BranchCodeSelect, dateParam, RangeForm } from "../ui";

export const metadata = { title: "General ledger" };
export const dynamic = "force-dynamic";

const PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = { account?: string; from?: string; to?: string; page?: string; branch?: string };

export default async function LedgerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("accounting.ledger.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const [entities, accounts, branchOptions] = await Promise.all([
    loadEntities(admin, member.orgId),
    loadAccounts(admin, member.orgId),
    loadBranchCodeOptions(admin, member.orgId),
  ]);
  const branch = pickBranchCode(sp.branch, branchOptions);
  const fy = fiscalYearOf(defaultStartMonth(entities), today);
  let from = dateParam(sp.from, fy.start);
  let to = dateParam(sp.to, today);
  const problem = rangeProblem(from, to);
  if (problem) {
    from = fy.start;
    to = today;
  }
  const page = Math.max(0, Math.min(10_000, Number.parseInt(sp.page ?? "0", 10) || 0));
  const accountId = UUID.test(sp.account ?? "") ? (sp.account as string) : null;
  const ledger = accountId
    ? await loadLedger(admin, member.orgId, accountId, from, to, PAGE, page * PAGE, branch)
    : null;
  if (ledger) await recordAccess(admin, member, { entity: "accounting_journal", action: "list" });
  const tree = flattenTree(accounts);
  const pages = ledger ? Math.ceil(ledger.total_lines / PAGE) : 0;
  const link = (p: number) =>
    `/accounting/ledger?account=${accountId}&from=${from}&to=${to}&page=${p}${branch ? `&branch=${branch}` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="General ledger"
        description="One account (or a whole group) with its opening balance, every posted line and the running balance. Income and expense accounts open at the start of the fiscal year."
      />
      <RangeForm from={from} to={to}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Account</span>
          <select name="account" defaultValue={accountId ?? ""} className={`${selectClass} w-72`}>
            <option value="" disabled>
              Choose an account
            </option>
            {tree.map((a) => (
              <option key={a.id} value={a.id}>
                {`${"  ".repeat(a.depth)}${a.code} ${a.name}`}
              </option>
            ))}
          </select>
        </label>
        <BranchCodeSelect options={branchOptions} value={branch} />
      </RangeForm>
      {branch && (
        <Alert>
          <AlertDescription>{BRANCH_VIEW_NOTE}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert>
          <AlertDescription>{problem} Showing the fiscal year to date instead.</AlertDescription>
        </Alert>
      )}
      {accountId && !ledger && (
        <Alert>
          <AlertDescription>That account was not found.</AlertDescription>
        </Alert>
      )}
      {ledger && (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <p className="mb-2 text-sm font-medium">
              {ledger.account.code} {ledger.account.name}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Narration</TableHead>
                  {ledger.account.is_group && <TableHead>Account</TableHead>}
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-muted/40">
                  <TableCell colSpan={ledger.account.is_group ? 6 : 5}>Opening balance</TableCell>
                  <TableCell className="text-right">
                    <Balance value={Number(ledger.opening)} />
                  </TableCell>
                </TableRow>
                {ledger.lines.map((l) => (
                  <TableRow key={l.line_id}>
                    <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <Link className="underline" href={`/accounting/journals/${l.journal_id}`}>
                        {l.number}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-72 truncate">
                      {l.description ?? l.narration}
                    </TableCell>
                    {ledger.account.is_group && (
                      <TableCell className="text-xs">
                        <span className="font-mono">{l.account_code}</span> {l.account_name}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <Amount value={Number(l.debit)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={Number(l.credit)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Balance value={Number(l.balance)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={ledger.account.is_group ? 4 : 3}>
                    Period totals and closing balance
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(ledger.period_debit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(ledger.period_credit)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Balance value={Number(ledger.closing)} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
            {pages > 1 && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                {page > 0 && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={link(page - 1)}>Previous</Link>
                  </Button>
                )}
                <span className="text-muted-foreground">
                  Page {page + 1} of {pages}
                </span>
                {page + 1 < pages && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={link(page + 1)}>Next</Link>
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
