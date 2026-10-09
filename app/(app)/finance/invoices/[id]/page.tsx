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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.invoices.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient(); // RLS applies to every query below
  const { data: inv } = await supabase.from("fin_invoices").select("*").eq("id", id).maybeSingle();
  if (!inv) notFound();

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
            "id, claim_activity_number, cpt_code, net, remitted, rejected, claim_status, match_status, matched_line_id",
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
        <Button asChild variant="outline" size="sm">
          <Link href="/finance/invoices">Back to invoices</Link>
        </Button>
      </PageHeader>

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
