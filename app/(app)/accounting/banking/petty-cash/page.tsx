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
import { pettyCashCount, suggestCode, topUpNeeded } from "@/lib/accounting/banking";
import {
  journalNumbers,
  loadBalances,
  loadBranches,
  loadLedgers,
  loadTaxCodes,
  orgToday,
  plainLedgers,
} from "@/lib/accounting/banking-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { nameOf, peopleNames } from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance } from "../../ui";
import {
  CancelButton,
  CountButton,
  ExpenseButton,
  FloatButton,
  ReceiptOpen,
  SignCountButton,
  SweepButton,
} from "../forms";
import { canViewBanking, PostingBadge } from "../ui";

export const metadata = { title: "Petty cash" };
export const dynamic = "force-dynamic";

/** Petty cash floats per branch: expenses with receipts, top-ups, and the monthly count signed by a second person. */
export default async function PettyCashPage() {
  const member = await requireMember();
  if (!canViewBanking(member)) throw new ForbiddenError("accounting.banking.manage");
  const manage = can(member, "accounting.banking.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = await orgToday(admin, member.orgId);
  const [floats, ledgers, taxCodes, branches, expenses, counts, members] = await Promise.all([
    admin
      .from("acc_petty_cash_floats")
      .select("id, name, branch_code, account_id, imprest_amount, custodian_id, active")
      .eq("org_id", member.orgId)
      .order("name")
      .then((r) => r.data ?? []),
    loadLedgers(admin, member.orgId),
    loadTaxCodes(admin, member.orgId),
    loadBranches(admin, member.orgId),
    admin
      .from("acc_petty_cash_expenses")
      .select(
        "id, float_id, expense_date, amount, account_id, narration, reference, document_id, status, journal_id",
      )
      .eq("org_id", member.orgId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300)
      .then((r) => r.data ?? []),
    admin
      .from("acc_petty_cash_counts")
      .select(
        "id, float_id, month, count_date, counted_amount, book_balance, difference, explanation, status, sha256, prepared_by, signed_by, signed_at",
      )
      .eq("org_id", member.orgId)
      .order("month", { ascending: false })
      .limit(120)
      .then((r) => r.data ?? []),
    admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .then((r) => r.data ?? []),
  ]);
  const [balances, numbers, names] = await Promise.all([
    loadBalances(
      admin,
      member.orgId,
      floats.map((f) => f.account_id),
      today,
    ),
    journalNumbers(
      admin,
      expenses.map((e) => e.journal_id),
    ),
    peopleNames(admin, [
      ...members.map((m) => m.user_id),
      ...counts.flatMap((c) => [c.prepared_by, c.signed_by]),
    ]),
  ]);
  const floatName = new Map(floats.map((f) => [f.id, f.name]));
  const ledgerName = new Map(ledgers.map((l) => [l.id, `${l.code} · ${l.name}`]));
  const people = members
    .map((m) => ({ id: m.user_id, label: nameOf(names, m.user_id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const activeFloats = floats.filter((f) => f.active).map((f) => ({ id: f.id, label: f.name }));
  const codes = ledgers.map((l) => l.code);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Petty cash"
        description="A float per branch with its own cash ledger. Expenses are paid out of it with a receipt; a top-up (Transfers) brings it back to its amount; each month the cash is counted and a second person signs the count."
      >
        {manage && (
          <div className="flex flex-wrap gap-2">
            <SweepButton />
            <FloatButton
              branches={branches}
              people={people}
              suggestedCode={suggestCode("PC-", codes)}
            />
            {activeFloats.length > 0 && (
              <ExpenseButton
                floats={activeFloats}
                ledgers={plainLedgers(ledgers)}
                taxCodes={taxCodes}
                branches={branches}
                today={today}
              />
            )}
          </div>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Floats</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Float</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Custodian</TableHead>
                <TableHead className="text-right">Float amount</TableHead>
                <TableHead className="text-right">Book balance</TableHead>
                <TableHead className="text-right">Top-up needed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {floats.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    No floats yet.
                  </TableCell>
                </TableRow>
              )}
              {floats.map((f) => {
                const book = balances.get(f.account_id) ?? 0;
                return (
                  <TableRow key={f.id} className={f.active ? "" : "opacity-60"}>
                    <TableCell>
                      <div className="font-medium">{f.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {ledgerName.get(f.account_id)}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{f.branch_code ?? "—"}</TableCell>
                    <TableCell className="text-sm">
                      {f.custodian_id ? nameOf(names, f.custodian_id) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(f.imprest_amount)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Balance value={book} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(topUpNeeded(Number(f.imprest_amount), book))}
                    </TableCell>
                    <TableCell className="flex flex-wrap justify-end gap-1">
                      {manage && f.active && (
                        <CountButton floatId={f.id} floatName={f.name} today={today} />
                      )}
                      {manage && (
                        <FloatButton
                          float={{ ...f, imprest_amount: Number(f.imprest_amount) }}
                          branches={branches}
                          people={people}
                          suggestedCode=""
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly counts</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Float</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Book</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Explanation</TableHead>
                <TableHead>Counted by</TableHead>
                <TableHead>Signed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground text-sm">
                    No counts yet.
                  </TableCell>
                </TableRow>
              )}
              {counts.map((c) => {
                const r = pettyCashCount(Number(c.counted_amount), Number(c.book_balance));
                return (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">
                      {c.month.slice(0, 7)}
                      <div className="text-muted-foreground text-xs">counted {c.count_date}</div>
                    </TableCell>
                    <TableCell className="text-sm">{floatName.get(c.float_id) ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(c.counted_amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(c.book_balance)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.state === "balanced" ? (
                        <Badge variant="success">Agrees</Badge>
                      ) : (
                        <span className="tabular-nums text-amber-700 dark:text-amber-400">
                          {r.state === "short" ? "Short " : "Over "}
                          {money(Math.abs(r.difference))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm">
                      {c.explanation ?? ""}
                    </TableCell>
                    <TableCell className="text-sm">{nameOf(names, c.prepared_by)}</TableCell>
                    <TableCell className="text-sm">
                      {c.status === "signed" ? (
                        `${nameOf(names, c.signed_by)}, ${c.signed_at?.slice(0, 10)}`
                      ) : manage && c.prepared_by !== member.userId ? (
                        <SignCountButton id={c.id} sha256={c.sha256} />
                      ) : (
                        <Badge variant="warning">Waiting for a second person</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expenses</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Float</TableHead>
                <TableHead>Booked to</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground text-sm">
                    No expenses yet.
                  </TableCell>
                </TableRow>
              )}
              {expenses.map((e) => (
                <TableRow key={e.id} className={e.status === "cancelled" ? "opacity-60" : ""}>
                  <TableCell className="text-sm">{e.expense_date}</TableCell>
                  <TableCell className="text-sm">{floatName.get(e.float_id) ?? "—"}</TableCell>
                  <TableCell className="text-sm">{ledgerName.get(e.account_id) ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(e.amount)}</TableCell>
                  <TableCell className="max-w-64 truncate text-sm">
                    {e.narration}
                    {e.reference && <span className="text-muted-foreground"> · {e.reference}</span>}
                  </TableCell>
                  <TableCell>
                    {e.document_id ? (
                      <ReceiptOpen id={e.document_id} />
                    ) : (
                      <Badge variant="outline">None</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <PostingBadge
                      status={e.status}
                      journalId={e.journal_id}
                      number={e.journal_id ? numbers.get(e.journal_id) : undefined}
                    />
                  </TableCell>
                  <TableCell>
                    {manage && e.status !== "cancelled" && (
                      <CancelButton kind="expense" id={e.id} today={today} />
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
