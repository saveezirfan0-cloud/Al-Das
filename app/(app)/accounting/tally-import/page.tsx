import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { peopleNames } from "@/lib/accounting/accounting-server";
import type { TallyPlanReport } from "@/lib/accounting/tally/plan";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { nameOf } from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { DryRunReport } from "./report";
import { CommitPanel, TallyUpload } from "./upload-flow";

export const metadata = { title: "Tally import" };
export const dynamic = "force-dynamic";

const STATUS: Record<
  string,
  { label: string; variant: "outline" | "warning" | "success" | "secondary" }
> = {
  staged: { label: "Dry run", variant: "outline" },
  committing: { label: "Committing", variant: "warning" },
  committed: { label: "Committed", variant: "success" },
  discarded: { label: "Discarded", variant: "secondary" },
};

export default async function TallyImportPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const member = await requireMember();
  if (!can(member, "accounting.import")) throw new ForbiddenError("accounting.import");
  const { id } = await searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: imports } = await admin
    .from("acc_tally_imports")
    .select(
      "id, status, created_at, created_by, committed_at, file_bytes, opening_date, first_date, last_date, reconciled_at, periods_locked_at, report, result",
    )
    .eq("org_id", member.orgId)
    .eq("source", "file") // a Tally bridge pull (22J) is applied through these tables too, then removed
    .order("created_at", { ascending: false })
    .limit(30);
  const rows = imports ?? [];
  const people = await peopleNames(
    admin,
    rows.map((r) => r.created_by),
  );
  const open = id ? rows.find((r) => r.id === id) : undefined;
  const openReport = open ? (open.report as unknown as TallyPlanReport) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tally import"
        description="Bring Tally's groups, ledgers, opening balances and full voucher history into Pulse. Each import is matched on Tally's GUID, so importing again (or an updated export) never posts anything twice; a voucher altered in Tally is reversed and posted again."
      />
      {open && openReport ? (
        <>
          <div className="text-sm">
            <Link href="/accounting/tally-import" className="underline">
              All imports
            </Link>
          </div>
          {(open.status === "staged" || open.status === "committing") && (
            <CommitPanel id={open.id} status={open.status} report={openReport} />
          )}
          {open.status === "committed" && (
            <Card>
              <CardHeader>
                <CardTitle>Committed {open.committed_at?.slice(0, 10)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                Next: reconcile it with Tally&apos;s trial balance on the{" "}
                <Link href="/accounting/tally-reconciliation" className="underline">
                  Reconciliation
                </Link>{" "}
                page.
              </CardContent>
            </Card>
          )}
          <DryRunReport report={openReport} />
        </>
      ) : (
        <>
          <TallyUpload />
          <Card>
            <CardHeader>
              <CardTitle>Imports</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Uploaded</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Vouchers</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Reconciled</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground text-sm">
                        No imports yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => {
                    const rep = r.report as unknown as Partial<TallyPlanReport>;
                    const s = STATUS[r.status] ?? STATUS.staged;
                    return (
                      <TableRow key={r.id}>
                        <TableCell>{r.created_at.slice(0, 10)}</TableCell>
                        <TableCell>{nameOf(people, r.created_by)}</TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {rep.counts
                            ? `${rep.counts.toPost} to post, ${rep.counts.refused} refused`
                            : ""}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.first_date ? `${r.first_date} to ${r.last_date}` : ""}
                          {r.opening_date ? ` (opening ${r.opening_date})` : ""}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.reconciled_at ? r.reconciled_at.slice(0, 10) : ""}
                          {r.periods_locked_at ? ", months locked" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            href={`/accounting/tally-import?id=${r.id}`}
                            className="text-sm underline"
                          >
                            Open
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
