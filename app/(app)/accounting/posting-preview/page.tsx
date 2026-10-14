import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { comparePreview } from "@/lib/accounting/posting/preview";
import { loadLedgerStart, loadPreviewReport } from "@/lib/accounting/posting/server";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance, dateParam, RangeForm } from "../ui";

export const metadata = { title: "Posting preview" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; all?: string };

/** First day of the month `months` before the month of `date`. */
function monthsBefore(date: string, months: number): string {
  const [y, m] = date.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return d.toISOString().slice(0, 10);
}

export default async function PostingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requireMember();
  if (!canAny(member, ["accounting.reports.view", "accounting.ledger.view"]))
    throw new ForbiddenError("accounting.reports.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const ledgerStart = await loadLedgerStart(admin, member.orgId);
  const end = ledgerStart && ledgerStart < today ? ledgerStart : today;
  let from = dateParam(sp.from, monthsBefore(end, 2));
  let to = dateParam(sp.to, end);
  const tooLong = to < from || Date.parse(to) - Date.parse(from) > 730 * 86_400_000;
  if (tooLong) {
    from = monthsBefore(end, 2);
    to = end;
  }
  const rows = await loadPreviewReport(admin, member.orgId, from, to);
  const onlyDiff = sp.all !== "1";
  const { months, accounts, totals } = comparePreview(rows, { onlyDifferences: onlyDiff });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Posting preview"
        description="During the parallel run: what Pulse would post for each account and month (from Unite, payables, banking, the revenue share, labs and cash-ups) against the ledger, which before the ledger start holds the Tally mirror. Balances are debit minus credit."
      />
      <p className="text-muted-foreground text-sm">
        {ledgerStart
          ? `Ledger start: ${ledgerStart}. Items dated before it are previewed, from it on they post.`
          : "No ledger start set: every item is previewed and nothing posts."}{" "}
        <Link className="underline" href="/accounting/waiting">
          Waiting to post
        </Link>{" "}
        lists items that could not even be previewed.
      </p>
      <RangeForm from={from} to={to} hidden={onlyDiff ? {} : { all: "1" }} />
      {tooLong && (
        <Alert>
          <AlertDescription>
            Choose up to two years. Showing the default range instead.
          </AlertDescription>
        </Alert>
      )}
      <div className="text-sm">
        {onlyDiff ? (
          <Link
            className="underline"
            href={`/accounting/posting-preview?from=${from}&to=${to}&all=1`}
          >
            Show every account
          </Link>
        ) : (
          <Link className="underline" href={`/accounting/posting-preview?from=${from}&to=${to}`}>
            Show differences only
          </Link>
        )}
      </div>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Pulse preview</TableHead>
                <TableHead className="text-right">Ledger (Tally mirror)</TableHead>
                <TableHead className="text-right">Difference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-sm">
                    {onlyDiff ? "No differences in this range." : "Nothing in this range."}
                  </TableCell>
                </TableRow>
              )}
              {accounts.flatMap((a) =>
                a.months.map((m, i) => (
                  <TableRow key={`${a.code}|${m.month}`}>
                    <TableCell>
                      {i === 0 && (
                        <>
                          <span className="font-mono text-xs">{a.code}</span> {a.name}
                        </>
                      )}
                    </TableCell>
                    <TableCell>{m.month.slice(0, 7)}</TableCell>
                    <TableCell className="text-right">
                      <Balance value={m.preview} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Balance value={m.ledger} />
                    </TableCell>
                    <TableCell
                      className={`text-right ${m.difference !== 0 ? "font-medium text-amber-700" : ""}`}
                    >
                      <Balance value={m.difference} />
                    </TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
          {months.length > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              {months.length} month(s); {totals.accountsWithDifference} account(s) differ in at
              least one month.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
