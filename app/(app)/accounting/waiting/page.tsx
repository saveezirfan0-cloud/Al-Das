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
import { accountingErrorMessage } from "@/lib/accounting/errors";
import { loadLedgerStart, loadWaiting, WAITING_LIMIT } from "@/lib/accounting/posting/server";
import { isPostingSource, POSTING_SOURCE_LABELS } from "@/lib/accounting/posting/types";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { RetryButton } from "./controls";

export const metadata = { title: "Waiting to post" };
export const dynamic = "force-dynamic";

type Search = { reason?: string; kind?: string };

export default async function WaitingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requireMember();
  if (!canAny(member, ["accounting.ledger.view", "accounting.journals.approve"]))
    throw new ForbiddenError("accounting.ledger.view");
  const retry = can(member, "accounting.journals.approve");
  const sp = await searchParams;
  const reason = sp.reason && /^[a-z_]{1,40}$/.test(sp.reason) ? sp.reason : undefined;
  const kind = sp.kind && isPostingSource(sp.kind) ? sp.kind : undefined;
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ items, byReason, byState }, ledgerStart] = await Promise.all([
    loadWaiting(admin, member.orgId, { reason, kind }),
    loadLedgerStart(admin, member.orgId),
  ]);
  await recordAccess(admin, member, { entity: "accounting_journal", action: "list" });
  const total = byReason.reduce((a, r) => a + r.count, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Waiting to post"
        description="Finance items the posting engine could not post yet, with the reason. Fix the reason (a rule, a VAT code, an open period) and they post on the next run, or try them again now."
      >
        {retry && total > 0 && <RetryButton label="Try all again" variant="default" />}
      </PageHeader>
      <p className="text-muted-foreground text-sm">
        Posted: {byState.posted ?? 0}. Previewed (before the ledger start
        {ledgerStart ? ` of ${ledgerStart}` : ", not set yet"}): {byState.preview ?? 0}.{" "}
        <Link className="underline" href="/accounting/posting-preview">
          Compare the preview with Tally
        </Link>
        .
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href="/accounting/waiting">
          <Badge variant={reason ? "outline" : "default"}>All {total}</Badge>
        </Link>
        {byReason.map((r) => (
          <Link key={r.reason} href={`/accounting/waiting?reason=${r.reason}`}>
            <Badge variant={reason === r.reason ? "default" : "outline"}>
              {r.reason.replace(/_/g, " ")} {r.count}
            </Badge>
          </Link>
        ))}
      </div>
      {reason && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {accountingErrorMessage(reason, "Something went wrong. It will be tried again.")}
          </span>
          {retry && <RetryButton reason={reason} label="Try these again" />}
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>Tries</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    Nothing is waiting.
                  </TableCell>
                </TableRow>
              )}
              {items.map((i) => (
                <TableRow key={`${i.source_kind}|${i.source_id}`}>
                  <TableCell className="text-sm">{POSTING_SOURCE_LABELS[i.source_kind]}</TableCell>
                  <TableCell className="font-mono text-xs">{i.source_id}</TableCell>
                  <TableCell>{i.source_date ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {i.amount === null ? "" : money(i.amount)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="warning" className="mr-1">
                      {i.reason.replace(/_/g, " ")}
                    </Badge>
                    {i.detail ?? accountingErrorMessage(i.reason, "")}
                  </TableCell>
                  <TableCell>{i.attempts}</TableCell>
                  <TableCell className="text-right">
                    {retry && <RetryButton kind={i.source_kind} id={i.source_id} variant="ghost" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {items.length >= WAITING_LIMIT && (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing the first {WAITING_LIMIT}. Filter by a reason to see the rest.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
