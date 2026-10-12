import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { loadAccountMap } from "@/lib/finance/export-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ExportPanel, MappingForm, RemoveMapping } from "./export-controls";

export const metadata = { title: "Accounting export" };
export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const member = await requirePerm("finance.export.run");
  const today = todayIn(member.org.timezone);
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(firstOfThisMonth, -1) ?? today;
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const accounts = await loadAccountMap(createAdminClient(), member.orgId); // after the permission check
  const supabase = await createClient();
  const { data: log } = await supabase
    .from("fin_accounting_exports")
    .select("id, period_from, period_to, status, row_count, debit_total, created_at")
    .order("created_at", { ascending: false })
    .limit(15);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Accounting export"
        description="A journal CSV for Zoho Books, QuickBooks or any ledger that imports journals. One way only: Pulse writes the file and never reads anything back. It holds amounts, branches and categories, never patient data."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Download a period</CardTitle>
          <CardDescription>
            FINAL once every month in the period is locked by the month-end close, otherwise
            PROVISIONAL. Re-exporting the same data gives byte-identical files, so a re-import can
            be matched on the journal reference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExportPanel defaultFrom={lastMonthStart} defaultTo={lastMonthEnd} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            Which ledger account each kind of amount posts to. Nothing is exported until every
            account the period needs is mapped. Insurer settlements are not part of this file: book
            them from the bank statement.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <MappingForm />
          {accounts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts
                  .sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key))
                  .map((a) => (
                    <TableRow key={`${a.kind}:${a.key}`}>
                      <TableCell className="text-xs">{a.kind.replaceAll("_", " ")}</TableCell>
                      <TableCell className="text-xs">{a.key}</TableCell>
                      <TableCell className="font-mono text-xs">{a.account_code}</TableCell>
                      <TableCell className="text-xs">{a.account_name ?? ""}</TableCell>
                      <TableCell className="text-right">
                        <RemoveMapping kind={a.kind} keyName={a.key} />
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Previous exports</CardTitle>
        </CardHeader>
        <CardContent>
          {(log ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">None yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Debits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(log ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs">
                      {new Date(l.created_at).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.period_from} to {l.period_to}
                    </TableCell>
                    <TableCell className="text-xs">{l.status}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{l.row_count}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(l.debit_total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
