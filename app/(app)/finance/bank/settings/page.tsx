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
import { ruleProblem } from "@/lib/finance/bank-recon";
import { loadBankSettings, loadSettlementRules } from "@/lib/finance/bank-server";
import {
  BANK_IMPORT_KINDS,
  fieldsFor,
  IMPORT_KINDS,
  isImportKind,
  type AmountStyle,
} from "@/lib/finance/import-kinds";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  AccountButton,
  BankSettingsForm,
  FormatButton,
  RuleButton,
  StarterRulesButton,
  type FormatView,
} from "./forms";

export const metadata = { title: "Bank reconciliation settings" };
export const dynamic = "force-dynamic";

export default async function BankSettingsPage() {
  const member = await requirePerm("finance.bank.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: accounts }, { data: formatRows }, rules, settings] = await Promise.all([
    admin
      .from("fin_bank_accounts")
      .select("id, name, bank_name, last4, currency, ledger_name, receives_insurance, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("fin_import_formats")
      .select("id, kind, name, mapping, date_format, amount_style, active")
      .in("kind", [...BANK_IMPORT_KINDS])
      .eq("org_id", member.orgId)
      .order("name"),
    loadSettlementRules(admin, member.orgId),
    loadBankSettings(admin, member.orgId),
  ]);
  const accountLabel = new Map((accounts ?? []).map((a) => [a.id, `${a.name} (•••• ${a.last4})`]));
  const accountOptions = (accounts ?? [])
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: accountLabel.get(a.id)! }));
  const formats: FormatView[] = (formatRows ?? []).map((f) => ({
    ...f,
    mapping: (f.mapping ?? {}) as Record<string, string>,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bank reconciliation settings"
        description="Bank accounts, the layout of each bank's and processor's files, the settlement rule of each payment mode, and the matching thresholds. Every change is audited."
      >
        <Button asChild variant="outline">
          <Link href="/finance/bank">Back to bank reconciliation</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Bank accounts</CardTitle>
          <AccountButton offerLedger={can(member, "accounting.banking.manage")} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Bank</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Tally ledger</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(accounts ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState title="No accounts yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                (accounts ?? []).map((a) => (
                  <TableRow key={a.id} className={a.active ? "" : "opacity-60"}>
                    <TableCell>
                      {accountLabel.get(a.id)}
                      {a.receives_insurance && (
                        <Badge variant="secondary" className="ml-2">
                          Insurance receipts
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{a.bank_name}</TableCell>
                    <TableCell>{a.currency}</TableCell>
                    <TableCell>{a.ledger_name}</TableCell>
                    <TableCell className="text-right">
                      <AccountButton account={a} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">File layouts</CardTitle>
            <CardDescription>
              One per bank or processor export. The fields are fixed by Pulse; you give the header
              each one has in the file.
            </CardDescription>
          </div>
          <FormatButton />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Layout</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Columns read</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {formats.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState
                      title="No layouts yet"
                      description="Add one when the first sample statement or settlement report arrives."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                formats.map((f) => (
                  <TableRow key={f.id} className={f.active ? "" : "opacity-60"}>
                    <TableCell>{f.name}</TableCell>
                    <TableCell>
                      {isImportKind(f.kind) ? IMPORT_KINDS[f.kind].label : f.kind}
                    </TableCell>
                    <TableCell className="text-xs">
                      {isImportKind(f.kind) &&
                        fieldsFor(f.kind, f.amount_style as AmountStyle)
                          .filter((x) => f.mapping[x.key])
                          .map((x) => `${x.spec.label}: "${f.mapping[x.key]}"`)
                          .join("; ")}
                    </TableCell>
                    <TableCell>{f.date_format}</TableCell>
                    <TableCell className="text-right">
                      <FormatButton format={f} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Settlement rules by payment mode</CardTitle>
            <CardDescription>
              The payment mode must be written exactly as Unite writes it. Lags are in working days
              (weekend below).
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <StarterRulesButton />
            <RuleButton accounts={accountOptions} />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payment mode</TableHead>
                <TableHead>Lag</TableHead>
                <TableHead>Fee %</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Checked against</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState title="No rules yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                rules.map((r) => {
                  const problem = r.settlesToBank ? ruleProblem(r) : null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>{r.mode}</TableCell>
                      <TableCell className="tabular-nums">{r.lagDays ?? "-"}</TableCell>
                      <TableCell className="tabular-nums">{r.feePct ?? "-"}</TableCell>
                      <TableCell>{r.accountId ? accountLabel.get(r.accountId) : "-"}</TableCell>
                      <TableCell>
                        {r.source === "settlement" ? "Settlement report" : "Unite collections"}
                      </TableCell>
                      <TableCell>
                        {!r.settlesToBank ? (
                          <Badge variant="outline">Not paid into a bank</Badge>
                        ) : problem ? (
                          <Badge variant="destructive">{problem}</Badge>
                        ) : (
                          <Badge variant="secondary">Ready</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <RuleButton
                          accounts={accountOptions}
                          rule={{
                            id: r.id,
                            payment_mode: r.mode,
                            lag_days: r.lagDays,
                            fee_pct: r.feePct,
                            account_id: r.accountId,
                            settles_to_bank: r.settlesToBank,
                            source: r.source,
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matching and calendar</CardTitle>
        </CardHeader>
        <CardContent>
          <BankSettingsForm s={settings} />
        </CardContent>
      </Card>
    </div>
  );
}
