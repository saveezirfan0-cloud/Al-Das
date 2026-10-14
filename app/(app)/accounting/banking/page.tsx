import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
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
import { bookToBank, suggestCode } from "@/lib/accounting/banking";
import {
  bankLabel,
  isUncleared,
  loadCheques,
  loadLedgers,
  loadPosition,
  orgToday,
} from "@/lib/accounting/banking-server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance } from "../ui";
import { CreateLedgerButton, LinkLedgerForm, StatementBalanceButton, SweepButton } from "./forms";
import { canViewBanking, ChequeStatusBadge } from "./ui";

export const metadata = { title: "Bank accounts" };
export const dynamic = "force-dynamic";

/** Bank accounts: each 20C account's ledger, and the bank position (book to bank) per account. */
export default async function BankAccountsPage() {
  const member = await requireMember();
  if (!canViewBanking(member)) throw new ForbiddenError("accounting.banking.manage");
  const manage = can(member, "accounting.banking.manage");
  const recs = canAny(member, ["finance.bank.view", "finance.bank.manage", "finance.bank.signoff"]);
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = await orgToday(admin, member.orgId);
  const [position, ledgers, cheques] = await Promise.all([
    loadPosition(admin, member.orgId, today),
    loadLedgers(admin, member.orgId),
    loadCheques(admin, member.orgId),
  ]);
  const linked = new Set(position.map((p) => p.gl_account_id).filter(Boolean));
  const bankLedgers = ledgers.filter((l) => l.control === "bank" && l.is_active);
  const codes = ledgers.map((l) => l.code);
  const names = new Map(position.map((p) => [p.bank_account_id, bankLabel(p)]));
  const uncleared = cheques.filter(isUncleared);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bank accounts"
        description="Each bank account (from Finance, Bank reconciliation) points at its ledger. The position compares the books with the bank's own balance."
      >
        {manage && <SweepButton />}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts and their ledgers</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bank account</TableHead>
                <TableHead>Ledger</TableHead>
                <TableHead className="text-right">Book balance today</TableHead>
                <TableHead>Reconciliation (Finance)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {position.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState
                      title="No bank accounts yet"
                      description="Finance adds them under Bank reconciliation, Settings."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              )}
              {position.map((p) => (
                <TableRow key={p.bank_account_id} className={p.active ? "" : "opacity-60"}>
                  <TableCell>
                    <div className="font-medium">{bankLabel(p)}</div>
                    <div className="text-muted-foreground text-xs">
                      {p.bank_name} · {p.currency}
                    </div>
                  </TableCell>
                  <TableCell>
                    {p.gl_account_id ? (
                      <div className="flex flex-col gap-1">
                        <Link
                          href={`/accounting/ledger?account=${p.gl_account_id}`}
                          className="text-primary text-sm underline"
                        >
                          {p.gl_code} · {p.gl_name}
                        </Link>
                        {manage && (
                          <LinkLedgerForm
                            bankAccountId={p.bank_account_id}
                            current={p.gl_account_id}
                            ledgers={bankLedgers.filter(
                              (l) => l.id === p.gl_account_id || !linked.has(l.id),
                            )}
                          />
                        )}
                      </div>
                    ) : manage ? (
                      <div className="flex flex-col gap-2">
                        <CreateLedgerButton
                          bankAccountId={p.bank_account_id}
                          suggestedCode={suggestCode("1150-", codes)}
                          suggestedName={`Bank - ${p.name}`}
                        />
                        <LinkLedgerForm
                          bankAccountId={p.bank_account_id}
                          current={null}
                          ledgers={bankLedgers.filter((l) => !linked.has(l.id))}
                        />
                      </div>
                    ) : (
                      <Badge variant="warning">Not linked</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.gl_balance === null ? "—" : <Balance value={p.gl_balance} />}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.latest_rec ? (
                      recs ? (
                        <Link
                          href={`/finance/bank/${p.latest_rec.id}`}
                          className="text-primary underline"
                        >
                          {p.latest_rec.month.slice(0, 7)} · {p.latest_rec.status}
                        </Link>
                      ) : (
                        `${p.latest_rec.month.slice(0, 7)} · ${p.latest_rec.status}`
                      )
                    ) : (
                      <span className="text-muted-foreground">None yet</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank position (book to bank)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="text-muted-foreground mb-3 text-sm">
            On the date of the latest statement balance: the book balance, plus cheques we issued
            that the bank has not paid yet, minus cheques we received that it has not credited yet,
            should equal the statement. What is left are bank items the books do not have yet
            (charges, direct debits, receipts not matched).
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Statement</TableHead>
                <TableHead className="text-right">Book</TableHead>
                <TableHead className="text-right">+ Issued, not paid</TableHead>
                <TableHead className="text-right">− Received, not credited</TableHead>
                <TableHead className="text-right">Should show</TableHead>
                <TableHead className="text-right">Statement</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Statement lines not matched</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {position.map((p) => {
                const r =
                  p.statement_balance !== null && p.gl_at_statement !== null
                    ? bookToBank({
                        glAtStatement: p.gl_at_statement,
                        statementBalance: p.statement_balance,
                        unclearedIssued: p.uncleared_issued.amount,
                        unclearedReceived: p.uncleared_received.amount,
                      })
                    : null;
                return (
                  <TableRow key={p.bank_account_id}>
                    <TableCell className="font-medium">{bankLabel(p)}</TableCell>
                    <TableCell className="text-sm">
                      {p.statement_date ?? "No balance entered"}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.gl_at_statement === null ? "—" : <Balance value={p.gl_at_statement} />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(p.uncleared_issued.amount)}
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({p.uncleared_issued.count})
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(p.uncleared_received.amount)}
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({p.uncleared_received.count})
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r ? money(r.expectedBank) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.statement_balance === null ? "—" : money(p.statement_balance)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r ? (
                        r.reconciled ? (
                          <Badge variant="success">Agrees</Badge>
                        ) : (
                          <span className="tabular-nums text-amber-700 dark:text-amber-400">
                            {money(r.difference)}
                          </span>
                        )
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.unmatched_lines.count === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        <Link href="/accounting/banking/entries" className="text-primary underline">
                          {p.unmatched_lines.count}: in {money(p.unmatched_lines.credits)}, out{" "}
                          {money(p.unmatched_lines.debits)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {manage && (
                        <StatementBalanceButton bankAccountId={p.bank_account_id} today={today} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {position.some((p) => p.post_dated.count > 0) && (
            <p className="text-muted-foreground mt-3 text-sm">
              Post-dated cheques not yet due (not in the books):{" "}
              {position
                .filter((p) => p.post_dated.count > 0)
                .map(
                  (p) =>
                    `${bankLabel(p)} issued ${money(p.post_dated.issued)}, received ${money(p.post_dated.received)}`,
                )
                .join("; ")}
              .
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uncleared cheques</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cheque</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uncleared.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="Every posted cheque has cleared" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {uncleared.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.cheque_no}</TableCell>
                  <TableCell className="text-sm">{names.get(c.bank_account_id) ?? "—"}</TableCell>
                  <TableCell className="text-sm">{c.cheque_date}</TableCell>
                  <TableCell className="text-sm">
                    {c.direction === "issued" ? "Issued" : "Received"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                  <TableCell>
                    <ChequeStatusBadge status={c.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-2 text-sm">
            <Link href="/accounting/banking/cheques" className="text-primary underline">
              Open the cheque register
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
