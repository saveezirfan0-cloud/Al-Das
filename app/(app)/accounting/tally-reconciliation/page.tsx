import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
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
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { LockImportButton, ReconcileForm } from "./forms";

export const metadata = { title: "Tally reconciliation" };
export const dynamic = "force-dynamic";

type DiffRow = {
  code: string | null;
  name: string;
  tally_name: string | null;
  pulse: number;
  tally: number;
  difference: number;
};

export default async function TallyReconciliationPage() {
  const member = await requireMember();
  if (!can(member, "accounting.import")) throw new ForbiddenError("accounting.import");
  const lock = can(member, "accounting.periods.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: imports }, { data: recs }, { data: entities }] = await Promise.all([
    admin
      .from("acc_tally_imports")
      .select(
        "id, entity_id, committed_at, first_date, last_date, opening_date, reconciled_at, periods_locked_at",
      )
      .eq("org_id", member.orgId)
      .eq("status", "committed")
      .order("committed_at", { ascending: false })
      .limit(30),
    admin
      .from("acc_tally_reconciliations")
      .select(
        "id, import_id, as_at, compared, differences, total_difference, reconciled, rows, created_at",
      )
      .eq("org_id", member.orgId)
      .eq("source", "file") // the Tally bridge's daily checks are on its own page
      .order("created_at", { ascending: false })
      .limit(10),
    admin
      .from("acc_entities")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("is_default", { ascending: false })
      .order("name"),
  ]);
  const entityName = new Map((entities ?? []).map((e) => [e.id, e.name]));
  const latest = recs?.[0];
  const diffs = (latest?.rows as unknown as DiffRow[] | undefined) ?? [];
  const label = (i: {
    entity_id: string;
    committed_at: string | null;
    first_date: string | null;
    last_date: string | null;
  }) =>
    `${(entities ?? []).length > 1 ? `${entityName.get(i.entity_id) ?? "?"}: ` : ""}Committed ${i.committed_at?.slice(0, 10) ?? ""}${i.first_date ? ` (${i.first_date} to ${i.last_date})` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tally reconciliation"
        description="Compare Pulse's trial balance with Tally's, ledger by ledger. Export the trial balance from Tally to Excel (detailed, with the ledgers shown) at the import's last date and upload it here. Every difference must be zero before the import counts as reconciled and its months can be locked."
      />
      <Card>
        <CardHeader>
          <CardTitle>Compare with Tally</CardTitle>
          <CardDescription>
            The file needs a name column (Particulars) and Debit and Credit columns; group subtotal
            rows are ignored. Tally&apos;s Profit &amp; Loss A/c is compared with retained earnings
            plus earlier years&apos; profit not yet closed. The file is not kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReconcileForm
            imports={(imports ?? []).map((i) => ({
              id: i.id,
              label: label(i),
              last_date: i.last_date,
            }))}
            today={todayIn(member.org.timezone)}
            entities={entities ?? []}
          />
        </CardContent>
      </Card>

      {latest && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Latest comparison, as at {latest.as_at}
              <Badge variant={latest.reconciled ? "success" : "destructive"}>
                {latest.reconciled ? "Reconciled" : `${latest.differences} difference(s)`}
              </Badge>
            </CardTitle>
            <CardDescription>
              {latest.compared} ledger(s) compared
              {latest.reconciled
                ? "."
                : `; total difference ${money(Number(latest.total_difference))}.`}{" "}
              Amounts are debit minus credit.
            </CardDescription>
          </CardHeader>
          {diffs.length > 0 && (
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ledger</TableHead>
                    <TableHead className="text-right">Pulse</TableHead>
                    <TableHead className="text-right">Tally</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diffs.map((d, i) => (
                    <TableRow key={`${d.code ?? d.tally_name}-${i}`}>
                      <TableCell>
                        {d.code && (
                          <span className="text-muted-foreground mr-2 font-mono text-xs">
                            {d.code}
                          </span>
                        )}
                        {d.name}
                        {!d.code && (
                          <span className="text-muted-foreground ml-2 text-xs">(not in Pulse)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(Number(d.pulse))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(Number(d.tally))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(Number(d.difference))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Imports</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Import</TableHead>
                <TableHead>Reconciled</TableHead>
                <TableHead>Months</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(imports ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState title="No committed imports yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {(imports ?? []).map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{label(i)}</TableCell>
                  <TableCell>
                    {i.reconciled_at ? i.reconciled_at.slice(0, 10) : "Not yet"}
                  </TableCell>
                  <TableCell>{i.periods_locked_at ? "Locked" : "Open"}</TableCell>
                  <TableCell className="text-right">
                    {lock && i.reconciled_at && !i.periods_locked_at && (
                      <LockImportButton id={i.id} />
                    )}
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
