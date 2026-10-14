import Link from "next/link";

import { selectClass } from "@/components/finance/forms";
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
import { loadDayBook, loadEntities } from "@/lib/accounting/accounting-server";
import { VOUCHER_TYPE_LABELS, type VoucherType } from "@/lib/accounting/journal";
import { rangeProblem } from "@/lib/accounting/reports";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { Amount, dateParam, JournalStatusBadge, RangeForm } from "../ui";

export const metadata = { title: "Day book" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; entity?: string };

export default async function DayBookPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("accounting.ledger.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  let from = dateParam(sp.from, `${today.slice(0, 7)}-01`);
  let to = dateParam(sp.to, today);
  const problem = rangeProblem(from, to, 366);
  if (problem) {
    from = `${today.slice(0, 7)}-01`;
    to = today;
  }
  const admin = createAdminClient(); // service role AFTER the permission check
  const entities = await loadEntities(admin, member.orgId);
  const entity = entities.find((e) => e.id === sp.entity)?.id ?? null;
  const book = await loadDayBook(admin, member.orgId, entity, from, to);
  await recordAccess(admin, member, { entity: "accounting_journal", action: "list" });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Day book"
        description="Every posted journal in date order, with its lines. Reversed journals stay, next to their reversal."
      />
      <RangeForm from={from} to={to}>
        {entities.length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Entity</span>
            <select name="entity" defaultValue={entity ?? ""} className={`${selectClass} w-48`}>
              <option value="">All entities</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </RangeForm>
      {problem && (
        <Alert>
          <AlertDescription>
            {problem} Showing this month instead (at most a year at a time).
          </AlertDescription>
        </Alert>
      )}
      {book.truncated && (
        <Alert>
          <AlertDescription>
            Only the first 1,000 journals are shown. Choose a shorter range.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {book.journals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-sm">
                    Nothing posted in this range.
                  </TableCell>
                </TableRow>
              )}
              {book.journals.flatMap((j) => [
                <TableRow key={j.id} className="bg-muted/40">
                  <TableCell className="whitespace-nowrap">{j.date}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    <Link className="underline" href={`/accounting/journals/${j.id}`}>
                      {j.number}
                    </Link>
                  </TableCell>
                  <TableCell colSpan={3}>
                    <span className="text-muted-foreground mr-2 text-xs">
                      {VOUCHER_TYPE_LABELS[j.voucher_type as VoucherType] ?? j.voucher_type}
                    </span>
                    {j.narration}
                    {j.status === "reversed" && (
                      <span className="ml-2">
                        <JournalStatusBadge status="reversed" />
                      </span>
                    )}
                  </TableCell>
                </TableRow>,
                ...j.lines.map((l) => (
                  <TableRow key={`${j.id}-${l.line_no}`}>
                    <TableCell />
                    <TableCell />
                    <TableCell>
                      <span className="font-mono text-xs">{l.account_code}</span> {l.account_name}
                      {l.description && (
                        <span className="text-muted-foreground ml-2 text-xs">{l.description}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={Number(l.debit)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={Number(l.credit)} />
                    </TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
