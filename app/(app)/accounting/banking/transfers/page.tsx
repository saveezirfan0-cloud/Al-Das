import { CappedNote, EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TRANSFER_LABELS, type TransferKind } from "@/lib/accounting/banking";
import {
  journalNumbers,
  loadBalances,
  loadBranches,
  loadLedgers,
  moneyLedgers,
  orgToday,
} from "@/lib/accounting/banking-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance } from "../../ui";
import { CancelButton, SweepButton, TransferButton } from "../forms";
import { canViewBanking, PostingBadge } from "../ui";

export const metadata = { title: "Transfers" };
export const dynamic = "force-dynamic";

/** Contra: bank to bank, cash deposits and withdrawals, petty cash top-ups. */
export default async function TransfersPage() {
  const member = await requireMember();
  if (!canViewBanking(member)) throw new ForbiddenError("accounting.banking.manage");
  const manage = can(member, "accounting.banking.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = await orgToday(admin, member.orgId);
  const [ledgers, branches, floats, transfers] = await Promise.all([
    loadLedgers(admin, member.orgId),
    loadBranches(admin, member.orgId),
    admin
      .from("acc_petty_cash_floats")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name")
      .then((r) => r.data ?? []),
    admin
      .from("acc_bank_transfers")
      .select(
        "id, kind, transfer_date, from_account_id, to_account_id, amount, reference, narration, status, journal_id",
      )
      .eq("org_id", member.orgId)
      .order("transfer_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300)
      .then((r) => r.data ?? []),
  ]);
  const money_ = moneyLedgers(ledgers);
  const [balances, numbers] = await Promise.all([
    loadBalances(
      admin,
      member.orgId,
      money_.map((a) => a.id),
      today,
    ),
    journalNumbers(
      admin,
      transfers.map((t) => t.journal_id),
    ),
  ]);
  const byId = new Map(ledgers.map((l) => [l.id, l]));
  const label = (id: string) => {
    const l = byId.get(id);
    return l ? `${l.code} · ${l.name}` : "—";
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Transfers"
        description="Money moved between bank and cash accounts (Contra vouchers): bank to bank, cash deposited or withdrawn, petty cash top-ups."
      >
        {manage && (
          <div className="flex flex-wrap gap-2">
            <SweepButton />
            <TransferButton
              accounts={money_}
              floats={floats.map((f) => ({ id: f.id, label: f.name }))}
              branches={branches}
              today={today}
            />
          </div>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank and cash balances today</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {money_.map((a) => (
            <div key={a.id} className="flex gap-2">
              <span className="text-muted-foreground">
                {a.code} · {a.name}
              </span>
              <Balance value={balances.get(a.id) ?? 0} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <EmptyState title="No transfers yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {transfers.map((t) => (
                <TableRow key={t.id} className={t.status === "cancelled" ? "opacity-60" : ""}>
                  <TableCell className="text-sm">{t.transfer_date}</TableCell>
                  <TableCell className="text-sm">
                    {TRANSFER_LABELS[t.kind as TransferKind]}
                  </TableCell>
                  <TableCell className="text-sm">{label(t.from_account_id)}</TableCell>
                  <TableCell className="text-sm">{label(t.to_account_id)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(t.amount)}</TableCell>
                  <TableCell className="max-w-64 truncate text-sm">
                    {t.narration}
                    {t.reference && <span className="text-muted-foreground"> · {t.reference}</span>}
                  </TableCell>
                  <TableCell>
                    <PostingBadge
                      status={t.status}
                      journalId={t.journal_id}
                      number={t.journal_id ? numbers.get(t.journal_id) : undefined}
                    />
                  </TableCell>
                  <TableCell>
                    {manage && t.status !== "cancelled" && (
                      <CancelButton kind="transfer" id={t.id} today={today} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {transfers.length >= 300 && <CappedNote shown={300} />}
        </CardContent>
      </Card>
    </div>
  );
}
