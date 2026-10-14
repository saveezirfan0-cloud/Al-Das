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
import {
  availableChequeActions,
  nextLeaf,
  PARTY_LABELS,
  type PartyKind,
} from "@/lib/accounting/banking";
import {
  bankLabel,
  chequeLedgers,
  journalNumbers,
  loadBankAccounts,
  loadCheques,
  loadLedgers,
  orgToday,
  plainLedgers,
} from "@/lib/accounting/banking-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  ChequeBookButton,
  ChequeButton,
  ChequeStepButton,
  ClearFlagButton,
  CloseBookButton,
  SweepButton,
} from "../forms";
import { canViewBanking, ChequeStatusBadge, PostingBadge } from "../ui";

export const metadata = { title: "Cheques" };
export const dynamic = "force-dynamic";

/** The cheque register (issued and received), cheque books, vouchers paid by cheque and parties with a bounced cheque. */
export default async function ChequesPage() {
  const member = await requireMember();
  if (!canViewBanking(member)) throw new ForbiddenError("accounting.banking.manage");
  const manage = can(member, "accounting.banking.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = await orgToday(admin, member.orgId);
  const [banks, ledgers, cheques, books, flags, suppliers, payers, vouchers] = await Promise.all([
    loadBankAccounts(admin, member.orgId),
    loadLedgers(admin, member.orgId),
    loadCheques(admin, member.orgId),
    admin
      .from("acc_cheque_books")
      .select("id, bank_account_id, first_number, last_number, next_number, width, active")
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false })
      .then((r) => r.data ?? []),
    admin
      .from("acc_party_flags")
      .select("id, cheque_id, reason, party_kind, party_ref, party_name, created_at")
      .eq("org_id", member.orgId)
      .is("cleared_at", null)
      .order("created_at", { ascending: false })
      .then((r) => r.data ?? []),
    admin
      .from("fin_suppliers")
      .select("id, name")
      .eq("org_id", member.orgId)
      .order("name")
      .then((r) => r.data ?? []),
    admin
      .from("fin_ref_payers")
      .select("payer_id, payer_name")
      .eq("org_id", member.orgId)
      .order("payer_name")
      .then((r) => r.data ?? []),
    // approved vouchers paid by cheque (special categories stay with their own reviewers)
    admin
      .from("fin_payment_vouchers")
      .select("id, voucher_no, payee_name, supplier_id, amount, payment_date, payment_reference")
      .eq("org_id", member.orgId)
      .eq("payment_method", "cheque")
      .eq("special_category", "none")
      .in("status", ["approved", "for_tally", "paid"])
      .order("voucher_date", { ascending: false })
      .limit(200)
      .then((r) => r.data ?? []),
  ]);
  const numbers = await journalNumbers(
    admin,
    cheques.map((c) => c.journal_id),
  );
  const registered = new Set(cheques.map((c) => c.voucher_id).filter(Boolean));
  const waitingVouchers = vouchers.filter((v) => !registered.has(v.id));
  const linkedBanks = banks.filter((b) => b.gl_account_id && b.active);
  const bankOptions = linkedBanks.map((b) => ({ id: b.id, label: bankLabel(b) }));
  const bankName = new Map(banks.map((b) => [b.id, bankLabel(b)]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const payerName = new Map(payers.map((p) => [p.payer_id, p.payer_name]));
  const chequeNo = new Map(cheques.map((c) => [c.id, c.cheque_no]));
  const bookOptions = books
    .filter((b) => b.active)
    .map((b) => {
      const next = nextLeaf({
        nextNumber: Number(b.next_number),
        lastNumber: Number(b.last_number),
        width: b.width,
      });
      return {
        id: b.id,
        bank_account_id: b.bank_account_id,
        label: next ? `Next leaf ${next}` : "Used up",
      };
    });
  const counter = chequeLedgers(ledgers);
  const payable = ledgers.find((l) => l.code === "2100" && l.is_active)?.id ?? null;
  const charges = plainLedgers(ledgers);
  const formProps = {
    banks: bankOptions,
    books: bookOptions,
    ledgers: counter,
    suppliers: suppliers.map((s) => ({ id: s.id, label: s.name })),
    payers: payers.map((p) => ({ id: p.payer_id, label: p.payer_name ?? p.payer_id })),
    today,
  };
  const who = (kind: string, ref: string | null, name: string | null) => {
    if (kind === "patient") return `Patient, PIN ${ref}`;
    if (kind === "supplier" && ref) return supplierName.get(ref) ?? name ?? "Supplier";
    if (kind === "payer" && ref) return payerName.get(ref) ?? name ?? ref;
    return name ?? `${PARTY_LABELS[kind as PartyKind] ?? kind} ${ref ?? ""}`.trim();
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cheques"
        description="Cheques we issue and cheques we receive. One dated today or earlier posts at once; a post-dated cheque posts on its date. A bounced, cancelled or stale cheque (six months after its date) reverses its posting."
      >
        {manage && (
          <div className="flex flex-wrap gap-2">
            <SweepButton />
            <ChequeBookButton banks={bankOptions} />
            {bankOptions.length > 0 && <ChequeButton {...formProps} defaultPayable={null} />}
          </div>
        )}
      </PageHeader>

      {manage && waitingVouchers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Vouchers paid by cheque, not yet in the register
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {waitingVouchers.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.voucher_no}</TableCell>
                    <TableCell className="text-sm">{v.payee_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.amount)}</TableCell>
                    <TableCell className="text-sm">
                      {v.payment_date ?? "—"}
                      {v.payment_reference && (
                        <span className="text-muted-foreground"> · {v.payment_reference}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {bankOptions.length > 0 && (
                        <ChequeButton
                          {...formProps}
                          defaultPayable={v.supplier_id ? payable : null}
                          prefill={{
                            voucher_id: v.id,
                            voucher_no: v.voucher_no,
                            amount: Number(v.amount),
                            payee: v.payee_name,
                            supplier_id: v.supplier_id,
                            cheque_no: /^\d{1,12}$/.test(v.payment_reference ?? "")
                              ? v.payment_reference!
                              : "",
                            date: v.payment_date ?? today,
                          }}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {flags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parties with a bounced cheque</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Party</TableHead>
                  <TableHead>Cheque</TableHead>
                  <TableHead>What it means</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {flags.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="text-sm">
                      {who(f.party_kind, f.party_ref, f.party_name)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {chequeNo.get(f.cheque_id) ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {f.reason === "bounced_cheque_received"
                        ? "Their cheque bounced: the amount is owed again; think twice before accepting another."
                        : "Our cheque to them bounced: they are still owed the amount."}
                    </TableCell>
                    <TableCell className="text-sm">{f.created_at.slice(0, 10)}</TableCell>
                    <TableCell>{manage && <ClearFlagButton id={f.id} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Register</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {manage && bankOptions.length === 0 && (
            <p className="text-muted-foreground mb-3 text-sm">
              Link a bank account to its ledger first (Bank accounts).
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cheque</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Party</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cheques.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <EmptyState title="No cheques yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {cheques.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.cheque_no}</TableCell>
                  <TableCell className="text-sm">
                    {bankName.get(c.bank_account_id) ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {c.cheque_date}
                    {c.post_dated && (
                      <Badge variant="outline" className="ml-1">
                        PDC
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {who(c.party_kind, c.party_ref, c.party_name)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.direction === "issued" ? money(c.amount) : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.direction === "received" ? money(c.amount) : ""}
                  </TableCell>
                  <TableCell>
                    <ChequeStatusBadge status={c.status} />
                    {c.status_reason && (
                      <div className="text-muted-foreground max-w-48 truncate text-xs">
                        {c.status_reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <PostingBadge
                      status={c.posting}
                      journalId={
                        c.posting === "posted" || c.posting === "reversed" ? c.journal_id : null
                      }
                      number={c.journal_id ? numbers.get(c.journal_id) : undefined}
                    />
                  </TableCell>
                  <TableCell className="flex flex-wrap justify-end gap-1">
                    {manage &&
                      availableChequeActions(
                        { status: c.status, chequeDate: c.cheque_date },
                        today,
                      ).map((a) => (
                        <ChequeStepButton
                          key={a}
                          id={c.id}
                          action={a}
                          today={today}
                          chargeAccounts={a === "bounce" ? charges : undefined}
                        />
                      ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cheque books</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Leaves</TableHead>
                <TableHead>Next</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {books.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState title="No cheque books yet" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {books.map((b) => {
                const pad = (n: number) => String(n).padStart(b.width, "0");
                const next = nextLeaf({
                  nextNumber: Number(b.next_number),
                  lastNumber: Number(b.last_number),
                  width: b.width,
                });
                return (
                  <TableRow key={b.id} className={b.active ? "" : "opacity-60"}>
                    <TableCell className="text-sm">
                      {bankName.get(b.bank_account_id) ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {pad(Number(b.first_number))} to {pad(Number(b.last_number))}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {b.active ? (next ?? "Used up") : "Closed"}
                    </TableCell>
                    <TableCell>{manage && b.active && <CloseBookButton id={b.id} />}</TableCell>
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
