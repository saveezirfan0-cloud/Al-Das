import Link from "next/link";
import { notFound } from "next/navigation";

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
import { loadJournalDetail } from "@/lib/accounting/accounting-server";
import {
  isManualVoucherType,
  SOURCE_KIND_LABELS,
  VOUCHER_TYPE_LABELS,
  type SourceKind,
} from "@/lib/accounting/journal";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { nameOf } from "@/lib/finance/vouchers-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { Amount, JournalStatusBadge } from "../../ui";
import {
  DiscardJournal,
  PostJournal,
  ReturnJournal,
  ReverseJournal,
  SubmitJournal,
} from "../journal-controls";

export const metadata = { title: "Journal" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  if (
    !canAny(member, [
      "accounting.ledger.view",
      "accounting.journals.prepare",
      "accounting.journals.approve",
    ])
  )
    throw new ForbiddenError("accounting.ledger.view");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const j = await loadJournalDetail(admin, member.orgId, id);
  if (!j) notFound();
  await recordAccess(admin, member, {
    entity: "accounting_journal",
    entityId: j.id,
    action: "view",
  });

  const manual = !j.source_kind;
  const isMaker = member.userId === j.prepared_by || member.userId === j.submitted_by;
  const canPrepare = can(member, "accounting.journals.prepare");
  const canApprove = can(member, "accounting.journals.approve");
  const draft = j.status === "draft";
  const waiting = draft && !!j.submitted_at;
  const linked = new Map(j.linked.map((x) => [x.id, x.number]));
  const debit = j.lines.reduce((s, l) => s + Math.round(l.debit * 100), 0) / 100;
  const credit = j.lines.reduce((s, l) => s + Math.round(l.credit * 100), 0) / 100;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={j.number ?? "Draft journal"}
        description={`${VOUCHER_TYPE_LABELS[j.voucher_type]} dated ${j.journal_date}${j.is_adjustment ? " (adjustment period)" : ""}`}
      >
        <JournalStatusBadge status={j.status} waiting={waiting} />
      </PageHeader>

      {j.return_remarks && draft && !waiting && (
        <Alert>
          <AlertDescription>
            Sent back by {nameOf(j.people, j.returned_by)}: {j.return_remarks}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <div className="text-muted-foreground text-xs">Narration</div>
            <div>{j.narration}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Source</div>
            <div>
              {j.source_kind
                ? `${SOURCE_KIND_LABELS[j.source_kind as SourceKind] ?? j.source_kind} ${j.source_kind === "reversal" ? "" : `${j.source_id} (version ${j.source_version})`}`
                : "Manual journal"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Prepared by</div>
            <div>{manual ? nameOf(j.people, j.prepared_by) : "The system"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Posted</div>
            <div>
              {j.posted_at
                ? `${j.posted_at.slice(0, 16).replace("T", " ")} by ${j.approved_by ? nameOf(j.people, j.approved_by) : "the system"}`
                : "Not yet"}
            </div>
          </div>
          {j.reversal_of && (
            <div>
              <div className="text-muted-foreground text-xs">Reverses</div>
              <Link className="underline" href={`/accounting/journals/${j.reversal_of}`}>
                {linked.get(j.reversal_of) ?? "the original journal"}
              </Link>
            </div>
          )}
          {j.reversed_by && (
            <div>
              <div className="text-muted-foreground text-xs">Reversed by</div>
              <Link className="underline" href={`/accounting/journals/${j.reversed_by}`}>
                {linked.get(j.reversed_by) ?? "the reversal"}
              </Link>
            </div>
          )}
          {j.auto_reverse_on && (
            <div>
              <div className="text-muted-foreground text-xs">Reverses automatically on</div>
              <div>{j.auto_reverse_on}</div>
            </div>
          )}
          <div className="sm:col-span-2 lg:col-span-3">
            <div className="text-muted-foreground text-xs">Fingerprint (sha256)</div>
            <div className="font-mono text-xs break-all">{j.sha256 ?? j.currentHash ?? "-"}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Description and dimensions</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {j.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.line_no}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{l.account_code}</span> {l.account_name}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {[
                      l.description,
                      l.branch_code && `Branch ${l.branch_code}`,
                      l.department && `Dept ${l.department}`,
                      l.doctor_id && `Doctor ${l.doctor_id}`,
                      l.payer_id && `Payer ${l.payer_id}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={l.debit} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={l.credit} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right tabular-nums">{money(debit)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(credit)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {draft && manual && canPrepare && isManualVoucherType(j.voucher_type) && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/accounting/journals/${j.id}/edit`}>Edit</Link>
          </Button>
        )}
        {draft && manual && canPrepare && !waiting && <SubmitJournal id={j.id} />}
        {draft && manual && canPrepare && <DiscardJournal id={j.id} />}
        {waiting && canApprove && !isMaker && j.currentHash && (
          <>
            <PostJournal id={j.id} hash={j.currentHash} />
            <ReturnJournal id={j.id} />
          </>
        )}
        {waiting && canApprove && isMaker && (
          <p className="text-muted-foreground text-sm">
            Someone other than the person who prepared this journal posts it.
          </p>
        )}
        {j.status === "posted" && canApprove && j.source_kind !== "reversal" && (
          <ReverseJournal id={j.id} defaultDate={todayIn(member.org.timezone)} />
        )}
      </div>
    </div>
  );
}
