import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { selectClass } from "@/components/finance/forms";
import { JOURNAL_LIST_LIMIT, loadJournalList } from "@/lib/accounting/accounting-server";
import {
  SOURCE_KIND_LABELS,
  VOUCHER_TYPE_LABELS,
  VOUCHER_TYPES,
  type JournalStatus,
  type SourceKind,
  type VoucherType,
} from "@/lib/accounting/journal";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam, JournalStatusBadge, RangeForm } from "../ui";

export const metadata = { title: "Journals" };
export const dynamic = "force-dynamic";

const READ = [
  "accounting.ledger.view",
  "accounting.journals.prepare",
  "accounting.journals.approve",
] as const;

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any status" },
  { value: "waiting", label: "Waiting to post" },
  { value: "draft", label: "Drafts" },
  { value: "posted", label: "Posted" },
  { value: "reversed", label: "Reversed" },
];

type Search = { status?: string; type?: string; from?: string; to?: string };

export default async function JournalsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requireMember();
  if (!canAny(member, READ)) throw new ForbiddenError("accounting.ledger.view");
  const sp = await searchParams;
  const status = ["waiting", "draft", "posted", "reversed"].includes(sp.status ?? "")
    ? (sp.status as JournalStatus | "waiting")
    : null;
  const type = (VOUCHER_TYPES as readonly string[]).includes(sp.type ?? "")
    ? (sp.type as VoucherType)
    : null;
  const from = sp.from ? dateParam(sp.from, "") || null : null;
  const to = sp.to ? dateParam(sp.to, "") || null : null;

  const admin = createAdminClient(); // service role AFTER the permission check
  const rows = await loadJournalList(admin, member.orgId, { status, type, from, to });
  await recordAccess(admin, member, { entity: "accounting_journal", action: "list" });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Journals"
        description="Every journal, manual or posted from a source. A posted journal never changes; it is corrected by a reversal."
      >
        {can(member, "accounting.journals.prepare") && (
          <Button asChild>
            <Link href="/accounting/journals/new">New journal</Link>
          </Button>
        )}
      </PageHeader>
      <RangeForm from={from ?? ""} to={to ?? ""}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <select name="status" defaultValue={status ?? ""} className={`${selectClass} w-44`}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Type</span>
          <select name="type" defaultValue={type ?? ""} className={`${selectClass} w-44`}>
            <option value="">Any type</option>
            {VOUCHER_TYPES.map((t) => (
              <option key={t} value={t}>
                {VOUCHER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </RangeForm>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    No journals match.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="whitespace-nowrap">{j.journal_date}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <Link className="underline" href={`/accounting/journals/${j.id}`}>
                        {j.number ?? "Draft"}
                      </Link>
                    </TableCell>
                    <TableCell>{VOUCHER_TYPE_LABELS[j.voucher_type]}</TableCell>
                    <TableCell className="max-w-72 truncate">{j.narration}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {j.source_kind
                        ? (SOURCE_KIND_LABELS[j.source_kind as SourceKind] ?? j.source_kind)
                        : "Manual"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(j.total)}</TableCell>
                    <TableCell>
                      <JournalStatusBadge status={j.status} waiting={!!j.submitted_at} />
                      {j.status === "draft" && j.returned_at && !j.submitted_at && (
                        <span className="text-muted-foreground ml-2 text-xs">sent back</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {rows.length === JOURNAL_LIST_LIMIT && (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing the latest {JOURNAL_LIST_LIMIT}. Narrow the dates to see more.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
