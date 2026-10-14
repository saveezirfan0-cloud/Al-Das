import Link from "next/link";
import { notFound } from "next/navigation";

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
import { PrintButton } from "@/components/shell/print-button";
import { can, canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { recordAccess } from "@/lib/security/access-log";
import { loadPostingStatus } from "@/lib/finance/invoice-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { money } from "@/lib/finance/format";
import { invoiceShares } from "@/lib/finance/invoice-shares";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

const POSTING_STATE_LABEL: Record<string, string> = {
  posted: "Posted",
  waiting: "Waiting to post",
  preview: "Previewed (before the ledger start date)",
  nothing: "Nothing to post",
  withdrawn: "Withdrawn (deleted in Unite)",
  not_seen: "Not looked at by the posting engine yet",
};

const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.invoices.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient(); // RLS applies to every query below
  const { data: inv } = await supabase.from("fin_invoices").select("*").eq("id", id).maybeSingle();
  if (!inv) notFound();
  await recordAccess(createAdminClient(), member, {
    entity: "finance_invoice",
    entityId: id,
    action: "view",
  });

  const canClaims = can(member, "finance.claims.view");
  const [
    { data: lines },
    { data: payments },
    { data: versions },
    { data: claims },
    { data: exceptions },
    appt,
    contact,
  ] = await Promise.all([
    supabase.from("fin_invoice_lines").select("*").eq("invoice_id", id).order("position"),
    supabase.from("fin_payments").select("*").eq("invoice_id", id).order("paid_date"),
    supabase
      .from("fin_invoice_versions")
      .select("id, version, received_at, record")
      .eq("invoice_id", id)
      .order("version", { ascending: false }),
    canClaims
      ? supabase
          .from("ins_claim_activities")
          .select(
            "id, claim_activity_number, cpt_code, net, initial_net, remitted, rejected, claim_status, match_status, matched_line_id, payer_id, receiver_id",
          )
          .eq("matched_invoice_id", id)
      : Promise.resolve({ data: [] }),
    supabase
      .from("ops_exceptions")
      .select("id, rule_code, status")
      .eq("entity_key", inv.inv_display_number)
      .in("status", ["open", "in_progress"]),
    inv.appointment_id
      ? supabase
          .from("appointments")
          .select("id, number, status, starts_at")
          .eq("source", "unite")
          .eq("external_id", inv.appointment_id.trim())
          .maybeSingle()
      : Promise.resolve({ data: null }),
    inv.patient_pin
      ? supabase
          .from("contacts")
          .select("id")
          .eq("external_id", inv.patient_pin)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const lineById = new Map((lines ?? []).map((l) => [l.id, l]));

  // Phase G: who pays. The split is the ledger's own rule (matched claims are the insurers' share, the rest the patient's);
  // an insurance invoice needs the claims permission to show it, a self-pay or corporate one does not.
  const matched = (claims ?? []).filter((c) => c.match_status === "matched");
  const isInsurance = /INSUR/i.test(inv.inv_type ?? "");
  const shares =
    canClaims || !isInsurance
      ? invoiceShares({
          invType: inv.inv_type,
          total: inv.total,
          writeOff: inv.write_off,
          creditNote: inv.credit_note,
          claims: matched.map((c) => ({
            payerId: c.payer_id,
            amount: c.initial_net ?? c.net,
            remitted: c.remitted,
            rejected: c.rejected,
          })),
          payments: (payments ?? []).map((p) => ({
            paid: p.paid,
            refund: p.refund,
            isCurrent: p.is_current,
          })),
        })
      : null;
  const payerIds = [...new Set(matched.map((c) => c.payer_id).filter((x): x is string => !!x))];
  const { data: payerRefs } = payerIds.length
    ? await supabase
        .from("fin_ref_payers")
        .select("payer_id, payer_name, receiver_id, receiver_name")
        .in("payer_id", payerIds)
    : { data: [] };
  const payerName = (id: string | null) =>
    id ? ((payerRefs ?? []).find((p) => p.payer_id === id)?.payer_name ?? id) : "Not known yet";
  const tpas = [
    ...new Set(
      matched
        .map((c) => {
          const ref = (payerRefs ?? []).find((p) => p.payer_id === c.payer_id);
          return ref?.receiver_name ?? c.receiver_id ?? null;
        })
        .filter((x): x is string => !!x),
    ),
  ];

  // Phase G: where the invoice stands in the ledger (accounting readers only; service role after the check)
  const canLedger = canAny(member, ["accounting.ledger.view", "accounting.journals.approve"]);
  const posting = canLedger
    ? await loadPostingStatus(createAdminClient(), member.orgId, inv.inv_display_number)
    : null;
  const mainLabel = shares?.mainParty === "corporate" ? "Company" : "Patient";
  const history = (versions ?? []).map((v, i, all) => {
    const rec = v.record as Record<string, unknown>;
    const prev = all[i + 1]?.record as Record<string, unknown> | undefined;
    const changed = prev
      ? [
          "net",
          "total",
          "gross",
          "discount",
          "vat",
          "is_deleted",
          "write_off",
          "credit_note",
        ].filter((k) => String(rec[k]) !== String(prev[k]))
      : [];
    return { ...v, rec, changed };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Invoice ${inv.inv_display_number}`}
        description={`${fmt(inv.transaction_date)} · ${fmt(inv.inv_type)} · branch ${inv.branch_code ?? "unknown"}`}
      >
        <PrintButton />
        <Button asChild variant="outline" size="sm" className="print:hidden">
          <a href={`/api/finance/invoices/${inv.id}/pdf`}>Internal PDF</a>
        </Button>
        <Button asChild variant="outline" size="sm" className="print:hidden">
          <Link href="/finance/invoices">Back to invoices</Link>
        </Button>
      </PageHeader>
      <p className="hidden text-sm font-semibold print:block">
        Internal copy — not a tax invoice. Printed from Pulse for finance use only.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {inv.is_deleted && <Badge variant="destructive">deleted in Unite</Badge>}
        {inv.is_package && <Badge variant="outline">package</Badge>}
        <Badge variant="outline">version {inv.version}</Badge>
        {(exceptions ?? []).map((e) => (
          <Link key={e.id} href={`/finance/exceptions/${e.id}`}>
            <Badge variant="warning">{e.rule_code} open</Badge>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Amounts</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              {(
                [
                  ["Gross", inv.gross],
                  ["Discount", inv.discount],
                  ["Net", inv.net],
                  ["VAT", inv.vat],
                  ["Total", inv.total],
                  ["Write-off", inv.write_off],
                  ["Credit note", inv.credit_note],
                ] as const
              ).map(([l, v]) => (
                <div key={l} className="contents">
                  <dt className="text-muted-foreground">{l}</dt>
                  <dd className="text-right tabular-nums">{money(v)}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doctor and patient</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div>
              {fmt(inv.doctor_name)}{" "}
              <span className="text-muted-foreground">({fmt(inv.doctor_dha_id)})</span>
            </div>
            <div className="text-muted-foreground">
              {fmt(inv.department)} · {fmt(inv.specialty)}
            </div>
            <div className="pt-2">
              Patient PIN: <span className="font-mono">{fmt(inv.patient_pin)}</span>
              {contact.data && can(member, "contacts.view") && (
                <>
                  {" "}
                  <Link className="underline" href={`/contacts?contact=${contact.data.id}`}>
                    open patient
                  </Link>
                </>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appointment</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {!inv.appointment_id ? (
              <span className="text-muted-foreground">Direct invoice (no appointment).</span>
            ) : appt.data ? (
              <>
                #{appt.data.number} · {appt.data.status} ·{" "}
                {new Date(appt.data.starts_at).toLocaleString()}
              </>
            ) : (
              <span className="text-muted-foreground">
                Appointment {inv.appointment_id} is not in the synced appointments (yet).
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who pays</CardTitle>
            <CardDescription>
              The split the ledger posts: matched claims are the insurer&apos;s share, the rest is
              the {mainLabel.toLowerCase()}&apos;s.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {!shares ? (
              <p className="text-muted-foreground">
                The insurer and patient shares come from the matched claims, which you do not have
                permission to see.
              </p>
            ) : (
              <>
                {shares.payerKind === "insurance" && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">Payer</dt>
                    <dd>
                      {shares.claimsPending
                        ? "Not known yet (no claim matched)"
                        : shares.insurers.map((s) => payerName(s.payerId)).join(", ")}
                    </dd>
                    <dt className="text-muted-foreground">TPA</dt>
                    <dd>{tpas.length ? tpas.join(", ") : "—"}</dd>
                  </dl>
                )}
                <dl className="grid grid-cols-2 gap-y-1">
                  {shares.payerKind === "insurance" && (
                    <>
                      <dt className="text-muted-foreground">Insurer share</dt>
                      <dd className="text-right tabular-nums">{money(shares.insurerShare)}</dd>
                      <dt className="text-muted-foreground">Still to collect from insurers</dt>
                      <dd className="text-right tabular-nums">{money(shares.insurerOutstanding)}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{mainLabel} share</dt>
                  <dd className="text-right tabular-nums">{money(shares.patientShare)}</dd>
                  <dt className="text-muted-foreground">{mainLabel} paid</dt>
                  <dd className="text-right tabular-nums">{money(shares.patientPaid)}</dd>
                  <dt className="font-medium">
                    {shares.balanceDue < 0
                      ? `Paid over the ${mainLabel.toLowerCase()} share`
                      : "Balance due"}
                  </dt>
                  <dd className="text-right font-semibold tabular-nums">
                    {money(Math.abs(shares.balanceDue))}
                  </dd>
                </dl>
                {shares.insurers.length > 1 && (
                  <ul className="text-muted-foreground text-xs">
                    {shares.insurers.map((s) => (
                      <li key={s.payerId ?? "none"}>
                        {payerName(s.payerId)}: share {money(s.share)}, remitted{" "}
                        {money(s.remitted)}, rejected {money(s.rejected)}, outstanding{" "}
                        {money(s.outstanding)}
                      </li>
                    ))}
                  </ul>
                )}
                {shares.claimsPending && (
                  <p className="text-muted-foreground text-xs">
                    No claim is matched yet, so the whole total waits on the insurer. The
                    patient&apos;s copay appears once the Diligence claim is matched.
                  </p>
                )}
                {shares.claimsExceed && (
                  <div>
                    <Badge variant="warning">Matched claims exceed the invoice total</Badge>
                  </div>
                )}
                {shares.adjustments !== 0 && (
                  <p className="text-muted-foreground text-xs">
                    After write-offs and credit notes of {money(shares.adjustments)}.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
        {posting && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ledger</CardTitle>
              <CardDescription>Where this invoice stands in the accounting ledger.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div>
                <Badge
                  variant={
                    posting.state === "posted"
                      ? "success"
                      : posting.state === "waiting"
                        ? "warning"
                        : "outline"
                  }
                >
                  {POSTING_STATE_LABEL[posting.state] ?? posting.state}
                </Badge>
              </div>
              {posting.journal && (
                <p>
                  Journal{" "}
                  <Link
                    className="font-mono underline-offset-2 hover:underline"
                    href={`/accounting/journals/${posting.journal.id}`}
                  >
                    {posting.journal.number ?? "draft"}
                  </Link>{" "}
                  <span className="text-muted-foreground">
                    dated {posting.journal.journal_date} ({posting.journal.status})
                  </span>
                </p>
              )}
              {posting.state === "waiting" && posting.reason && (
                <p className="text-muted-foreground">
                  Waiting: {posting.reason.replace(/_/g, " ")}
                  {posting.detail ? ` (${posting.detail})` : ""}.{" "}
                  <Link
                    className="underline"
                    href={`/accounting/waiting?kind=unite_invoice&reason=${posting.reason}`}
                  >
                    See what is waiting
                  </Link>
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
          <CardDescription>
            Lines that disappeared from a later version stay listed, marked as removed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>CPT</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>Remarks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(lines ?? []).map((l) => (
                <TableRow key={l.id} className={l.is_current ? undefined : "opacity-50"}>
                  <TableCell className="text-xs">{l.position}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono">{l.item_code}</span> {l.item_short_desc}{" "}
                    {!l.is_current && <Badge variant="outline">removed</Badge>}
                  </TableCell>
                  <TableCell className="text-xs">{fmt(l.cpt_code)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(l.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.line_net)}</TableCell>
                  <TableCell className="text-xs">{fmt(l.line_remarks)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {(payments ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No payments recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments ?? []).map((p) => (
                  <TableRow key={p.id} className={p.is_current ? undefined : "opacity-50"}>
                    <TableCell className="text-xs">{fmt(p.paid_date)}</TableCell>
                    <TableCell className="text-xs">{fmt(p.payment_mode)}</TableCell>
                    <TableCell className="font-mono text-xs">{fmt(p.receipt_number)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.refund)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canClaims && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Claims</CardTitle>
          </CardHeader>
          <CardContent>
            {(claims ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No claim activity matched to this invoice.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Claim activity</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Invoice line</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Remitted</TableHead>
                    <TableHead className="text-right">Rejected</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(claims ?? []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          className="underline-offset-2 hover:underline"
                          href={`/finance/claims/${c.id}`}
                        >
                          {c.claim_activity_number}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{c.cpt_code}</TableCell>
                      <TableCell className="text-xs">
                        {c.matched_line_id ? (
                          `#${lineById.get(c.matched_line_id)?.position ?? "?"}`
                        ) : (
                          <Badge variant="warning">{c.match_status}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.net)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.remitted)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.rejected)}</TableCell>
                      <TableCell className="text-xs">{fmt(c.claim_status)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Version history</CardTitle>
          <CardDescription>
            Each time Unite delivered this invoice. A new version means the content changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-3">
            {history.map((v) => (
              <li key={v.id} className="border-l-2 pl-4 text-sm">
                <div className="font-medium">
                  Version {v.version}{" "}
                  <span className="text-muted-foreground text-xs">
                    received {new Date(v.received_at).toLocaleString()}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  net {money(v.rec.net as number)} · total {money(v.rec.total as number)}
                  {v.changed.length > 0 && ` · changed: ${v.changed.join(", ")}`}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
