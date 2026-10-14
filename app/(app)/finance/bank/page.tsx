import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { BANK_IMPORT_KINDS } from "@/lib/finance/import-kinds";
import { createAdminClient } from "@/lib/supabase/admin";

import { ImportForm, NewRunForm, RemoveImportButton } from "./forms";

export const metadata = { title: "Bank reconciliation" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  open: { label: "Open", variant: "outline" },
  reviewed: { label: "Reviewed, waiting for sign-off", variant: "secondary" },
  signed: { label: "Signed", variant: "default" },
};

export default async function BankPage() {
  const member = await requirePerm("finance.bank.view");
  const manage = can(member, "finance.bank.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [
    { data: accounts },
    { data: formats },
    { data: rules },
    { data: recs },
    { data: imports },
  ] = await Promise.all([
    admin
      .from("fin_bank_accounts")
      .select("id, name, bank_name, last4, currency, receives_insurance, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("fin_import_formats")
      .select("id, kind, name")
      .in("kind", [...BANK_IMPORT_KINDS])
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
    admin
      .from("fin_ref_settlement_rules")
      .select("payment_mode")
      .eq("org_id", member.orgId)
      .order("payment_mode"),
    admin
      .from("fin_bank_recs")
      .select("id, account_id, month, period_start, period_end, status")
      .eq("org_id", member.orgId)
      .order("month", { ascending: false })
      .limit(36),
    admin
      .from("fin_bank_imports")
      .select(
        "id, kind, account_id, payment_mode, file_name, row_count, first_date, last_date, imported_at",
      )
      .eq("org_id", member.orgId)
      .order("imported_at", { ascending: false })
      .limit(20),
  ]);
  const accountName = new Map((accounts ?? []).map((a) => [a.id, `${a.name} (•••• ${a.last4})`]));
  const active = (accounts ?? []).filter((a) => a.active);
  const options = active.map((a) => ({ id: a.id, label: accountName.get(a.id)! }));
  const statementEnd = new Map<string, string>();
  for (const i of imports ?? [])
    if (i.account_id && i.last_date && (statementEnd.get(i.account_id) ?? "") < i.last_date)
      statementEnd.set(i.account_id, i.last_date);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bank reconciliation"
        description="Proves that every Unite collection reached the bank: card and EPG, Tabby, cash deposits and insurers' payments, by account and month."
      >
        {manage && (
          <Button asChild variant="outline">
            <Link href="/finance/bank/settings">Accounts, layouts and rules</Link>
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {(accounts ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No bank accounts yet.{" "}
              {manage && (
                <Link className="underline" href="/finance/bank/settings">
                  Add them in Settings
                </Link>
              )}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Latest statement line (recent imports)</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(accounts ?? []).map((a) => (
                  <TableRow key={a.id} className={a.active ? "" : "opacity-60"}>
                    <TableCell>{accountName.get(a.id)}</TableCell>
                    <TableCell>{a.bank_name}</TableCell>
                    <TableCell>{a.currency}</TableCell>
                    <TableCell className="tabular-nums">
                      {statementEnd.get(a.id) ?? "None"}
                    </TableCell>
                    <TableCell>
                      {a.receives_insurance && (
                        <Badge variant="secondary">Insurance receipts</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Import a statement or settlement report</CardTitle>
            <CardDescription>
              Read once on the server and not kept: only the rows of the mapped columns are stored,
              with card and account numbers masked. The same file twice, or dates that overlap an
              earlier import, are refused.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {options.length === 0 && (formats ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Add a bank account and a file layout in Settings first.
              </p>
            ) : (
              <ImportForm
                accounts={options}
                formats={formats ?? []}
                modes={(rules ?? []).map((r) => r.payment_mode)}
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reconciliations</CardTitle>
          <CardDescription>
            One per account and month. Work on it during the month (weekly by payment mode), then
            review it and have a second person sign it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {manage && options.length > 0 && (
            <NewRunForm accounts={options} month={todayIn(member.org.timezone).slice(0, 7)} />
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recs ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState title="No reconciliations yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                (recs ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link className="underline" href={`/finance/bank/${r.id}`}>
                        {r.month.slice(0, 7)}
                      </Link>
                    </TableCell>
                    <TableCell>{accountName.get(r.account_id) ?? ""}</TableCell>
                    <TableCell className="tabular-nums">
                      {r.period_start} to {r.period_end}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS[r.status]?.variant ?? "outline"}>
                        {STATUS[r.status]?.label ?? r.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent imports</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Imported</TableHead>
                <TableHead>File type</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(imports ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="Nothing imported yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                (imports ?? []).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="tabular-nums">{i.imported_at.slice(0, 10)}</TableCell>
                    <TableCell className="uppercase">{i.file_name ?? "-"}</TableCell>
                    <TableCell>
                      {i.kind === "bank_statement"
                        ? (accountName.get(i.account_id ?? "") ?? "")
                        : `${i.payment_mode} settlement`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{i.row_count}</TableCell>
                    <TableCell className="tabular-nums">
                      {i.first_date} to {i.last_date}
                    </TableCell>
                    <TableCell className="text-right">
                      {manage && <RemoveImportButton id={i.id} />}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
