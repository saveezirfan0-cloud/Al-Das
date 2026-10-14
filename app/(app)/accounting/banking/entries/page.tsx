import { EmptyState } from "@/components/shell/empty-state";
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
import { ENTRY_LABELS, entryIsMoneyIn, type EntryKind } from "@/lib/accounting/banking";
import {
  bankLabel,
  journalNumbers,
  loadBankAccounts,
  loadBranches,
  loadLedgers,
  loadTaxCodes,
  orgToday,
  plainLedgers,
} from "@/lib/accounting/banking-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { addDays } from "@/lib/finance/bank-recon";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { CancelButton, EntryButton, SweepButton } from "../forms";
import { canViewBanking, PostingBadge } from "../ui";

export const metadata = { title: "Bank entries" };
export const dynamic = "force-dynamic";

/** Bank charges, interest and direct debits or credits; unmatched statement lines can become entries. */
export default async function BankEntriesPage() {
  const member = await requireMember();
  if (!canViewBanking(member)) throw new ForbiddenError("accounting.banking.manage");
  const manage = can(member, "accounting.banking.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = await orgToday(admin, member.orgId);
  const [banks, ledgers, taxCodes, branches, entries] = await Promise.all([
    loadBankAccounts(admin, member.orgId),
    loadLedgers(admin, member.orgId),
    loadTaxCodes(admin, member.orgId),
    loadBranches(admin, member.orgId),
    admin
      .from("acc_bank_entries")
      .select(
        "id, bank_account_id, entry_date, kind, amount, account_id, narration, reference, status, journal_id, bank_line_id",
      )
      .eq("org_id", member.orgId)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300)
      .then((r) => r.data ?? []),
  ]);
  const linkedBanks = banks.filter((b) => b.gl_account_id && b.active);
  // unmatched statement lines of linked accounts in the last 120 days (20C imports)
  const { data: lines } = linkedBanks.length
    ? await admin
        .from("fin_bank_lines")
        .select("id, account_id, value_date, amount, reference, description")
        .eq("org_id", member.orgId)
        .eq("match_status", "unmatched")
        .in(
          "account_id",
          linkedBanks.map((b) => b.id),
        )
        .gte("value_date", addDays(today, -120))
        .order("value_date", { ascending: false })
        .limit(200)
    : { data: [] };
  const numbers = await journalNumbers(
    admin,
    entries.map((e) => e.journal_id),
  );
  const bankName = new Map(banks.map((b) => [b.id, bankLabel(b)]));
  const ledgerName = new Map(ledgers.map((l) => [l.id, `${l.code} · ${l.name}`]));
  const bankOptions = linkedBanks.map((b) => ({ id: b.id, label: bankLabel(b) }));
  const counter = plainLedgers(ledgers);
  const formProps = { banks: bankOptions, ledgers: counter, taxCodes, branches, today };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bank entries"
        description="Bank charges, interest and direct debits or credits that no other part of Pulse posts. VAT on a charge is split out when you choose a VAT code."
      >
        {manage && (
          <div className="flex flex-wrap gap-2">
            <SweepButton />
            {bankOptions.length > 0 && <EntryButton {...formProps} />}
          </div>
        )}
      </PageHeader>

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Statement lines nothing explains yet</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <p className="text-muted-foreground mb-3 text-sm">
              Unmatched lines of the last 120 days on accounts with a ledger. Turning one into an
              entry posts it and marks it matched in Finance&apos;s bank reconciliation. Receipts
              from patients and insurers are matched there, not here.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lines ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState title="Nothing waiting" className="border-0 p-6" />
                    </TableCell>
                  </TableRow>
                )}
                {(lines ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">{l.value_date}</TableCell>
                    <TableCell className="text-sm">{bankName.get(l.account_id) ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(l.amount) > 0 ? money(l.amount) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(l.amount) < 0 ? money(-Number(l.amount)) : ""}
                    </TableCell>
                    <TableCell className="max-w-72 truncate text-sm">
                      {[l.reference, l.description].filter(Boolean).join(" · ")}
                    </TableCell>
                    <TableCell>
                      <EntryButton
                        {...formProps}
                        line={{
                          id: l.id,
                          bank_account_id: l.account_id,
                          value_date: l.value_date,
                          amount: Number(l.amount),
                          reference: l.reference,
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {manage && bankOptions.length === 0 && (
            <p className="text-muted-foreground mb-3 text-sm">
              Link a bank account to its ledger first (Bank accounts).
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Booked to</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <EmptyState title="No bank entries yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => {
                const inward = entryIsMoneyIn(e.kind as EntryKind);
                return (
                  <TableRow key={e.id} className={e.status === "cancelled" ? "opacity-60" : ""}>
                    <TableCell className="text-sm">{e.entry_date}</TableCell>
                    <TableCell className="text-sm">
                      {bankName.get(e.bank_account_id) ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {ENTRY_LABELS[e.kind as EntryKind]}
                      {e.bank_line_id && (
                        <span className="text-muted-foreground"> · from statement</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{ledgerName.get(e.account_id) ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {inward ? money(e.amount) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {inward ? "" : money(e.amount)}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm">{e.narration}</TableCell>
                    <TableCell>
                      <PostingBadge
                        status={e.status}
                        journalId={e.journal_id}
                        number={e.journal_id ? numbers.get(e.journal_id) : undefined}
                      />
                    </TableCell>
                    <TableCell>
                      {manage && e.status !== "cancelled" && (
                        <CancelButton kind="entry" id={e.id} today={today} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
