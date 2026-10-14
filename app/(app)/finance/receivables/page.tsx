import Link from "next/link";

import { KpiCard } from "@/components/finance/kpi-card";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { parseReceivables, receivablesMatrix } from "@/lib/finance/followup";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Receivables by payer and age" };
export const dynamic = "force-dynamic";

const branchParam = (v: string | undefined) =>
  (v ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase() || null;

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const member = await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const branch = branchParam(sp.branch);
  const today = todayIn(member.org.timezone);

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const [{ data }, { data: branches }] = await Promise.all([
    admin.rpc("fin_receivables_by_payer_age", {
      p_org_id: member.orgId,
      p_today: today,
      p_branch: branch ?? undefined,
    }),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", member.orgId).order("code"),
  ]);
  const r = parseReceivables(data);
  const m = receivablesMatrix(r.aggregates, r.bucketDays);
  await recordAccess(admin, member, { entity: "finance_claim", action: "list" });
  const noDate = m.totals.cells[m.totals.cells.length - 1];
  const oldest = m.totals.cells[m.buckets.length - 1];
  const csvHref = `/api/finance/receivables${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Receivables by payer and age"
        description={
          <>
            Unpaid insurance claims as of {today}: net less remitted and approved write-offs, by
            payer and days since the claim date. All amounts in AED.
            {canAny(member, RECEIVABLES_READ) && (
              <>
                {" "}
                What business customers owe on Pulse&apos;s own sales invoices is in{" "}
                <Link href="/accounting/receivables-ageing" className="underline">
                  Accounting, Receivables ageing
                </Link>
                .
              </>
            )}
          </>
        }
      >
        <Button asChild variant="outline" size="sm">
          <a href={csvHref}>Download CSV</a>
        </Button>
      </PageHeader>

      <Alert>
        <AlertTitle>Proposed ARP report</AlertTitle>
        <AlertDescription>
          This is Pulse&apos;s proposal for the ARP report (accounts receivable from payers by age).
          Its exact definition is still open; compare it with the sheet you use today and tell us
          what differs. The age buckets are set in Settings, Finance workflow settings.
        </AlertDescription>
      </Alert>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Branch</span>
          <select
            name="branch"
            defaultValue={branch ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">All branches</option>
            {(branches ?? []).map((b) => (
              <option key={b.code} value={b.code}>
                {b.name ?? b.code}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/finance/followup">Insurance follow-up</Link>
        </Button>
      </form>

      {m.totals.claims === 0 ? (
        <Alert>
          <AlertTitle>Nothing outstanding</AlertTitle>
          <AlertDescription>
            No unpaid insurance claims{branch ? " for this branch" : ""}. Claims appear after a
            Diligence report is imported (Finance, Insurance upload). A branch is known only for
            claims matched to a Unite invoice.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <KpiCard
              label="Outstanding"
              value={m.totals.outstanding}
              goodWhen="neutral"
              note={`${m.totals.claims.toLocaleString()} claims, ${m.payers.length.toLocaleString()} payers`}
            />
            <KpiCard
              label={`Over ${m.buckets[m.buckets.length - 1].from - 1} days`}
              value={oldest.outstanding}
              goodWhen="neutral"
              note={`${oldest.claims.toLocaleString()} claims`}
            />
            <KpiCard
              label="No claim date"
              value={noDate.outstanding}
              goodWhen="neutral"
              note={`${noDate.claims.toLocaleString()} claims cannot be aged`}
            />
          </section>
          <Card>
            <CardHeader>
              <CardTitle>By payer</CardTitle>
              <CardDescription>
                Amount, with the number of claims underneath. Largest balances first.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payer</TableHead>
                    {m.buckets.map((b) => (
                      <TableHead key={b.index} className="text-right">
                        {b.label}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">No date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.payers.map((p) => (
                    <TableRow key={p.payerId}>
                      <TableCell className="text-sm">
                        <div>{p.payerName ?? p.payerId}</div>
                        {p.payerName && (
                          <div className="text-muted-foreground text-xs">{p.payerId}</div>
                        )}
                      </TableCell>
                      {p.cells.map((c, i) => (
                        <TableCell key={i} className="text-right tabular-nums">
                          {c.claims === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              <div>{money(c.outstanding)}</div>
                              <div className="text-muted-foreground text-xs">{c.claims}</div>
                            </>
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-medium tabular-nums">
                        <div>{money(p.outstanding)}</div>
                        <div className="text-muted-foreground text-xs">{p.claims}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    {m.totals.cells.map((c, i) => (
                      <TableCell key={i} className="text-right tabular-nums">
                        <div>{money(c.outstanding)}</div>
                        <div className="text-muted-foreground text-xs">{c.claims}</div>
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      <div>{money(m.totals.outstanding)}</div>
                      <div className="text-muted-foreground text-xs">{m.totals.claims}</div>
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
          <p className="text-muted-foreground text-xs">
            Aged from the claim&apos;s transaction date (Diligence), not the submission date.
            Remitted amounts are Diligence&apos;s; insurer payments are confirmed only against the
            bank and the remittance received.
          </p>
        </>
      )}
    </div>
  );
}
