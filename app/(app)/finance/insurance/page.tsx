import Link from "next/link";

import { HorizontalBars } from "@/components/finance/bars";
import { KpiCard } from "@/components/finance/kpi-card";
import { ProvenanceStrip } from "@/components/finance/provenance-strip";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { loadFreshness } from "@/lib/finance/freshness";
import { money } from "@/lib/finance/format";
import { parseInsuranceOverview, rate } from "@/lib/finance/insurance-overview";
import { buildProvenance } from "@/lib/finance/provenance";
import { currentMonth, monthParam, monthsAgo } from "@/lib/finance/summary";
import { monthEnd } from "@/lib/finance/summary-extras";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Insurance and receivables" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string };

export default async function InsurancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const from = monthParam(sp.from, monthsAgo(2));
  const to = monthParam(sp.to, currentMonth());
  const range = from <= to ? { from, to } : { from: to, to: from };
  const dates = { from: `${range.from}-01`, to: monthEnd(range.to) };

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const [{ data }, fresh] = await Promise.all([
    admin.rpc("fin_insurance_overview", {
      p_org_id: member.orgId,
      p_from: dates.from,
      p_to: dates.to,
    }),
    // the freshness view needs finance.view, which the Insurance role may not hold: it then simply has no strip
    loadFreshness(await createClient()),
  ]);
  const o = parseInsuranceOverview(data);
  const t = o.totals;
  const prov = fresh
    ? buildProvenance(
        { ...fresh, captureEnabled: fresh.captureEnabledFlag },
        ["diligence", "remittance"],
        dates,
      )
    : null;
  const links: Array<[string, string, string]> = [
    ["/finance/claims", "Claims", "finance.claims.view"],
    ["/finance/denials", "Denials", "finance.denials.manage"],
    ["/finance/remittance", "Remittance", "finance.remittance.manage"],
    ["/finance/scorecards", "Payer scorecards", "finance.scorecards.view"],
    ["/finance/forecast", "Collections forecast", "finance.forecast.view"],
    ["/finance/preauth", "Pre-authorisations", "finance.preauth.manage"],
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Insurance and receivables"
        description="Submitted, accepted, rejected, pending, resubmitted, paid and outstanding for claims in the range, by claim month. All amounts in AED."
      />
      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">From month</span>
          <input
            name="from"
            type="month"
            defaultValue={range.from}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">To month</span>
          <input
            name="to"
            type="month"
            defaultValue={range.to}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <div className="flex flex-wrap gap-2">
          {links
            .filter(([, , perm]) => can(member, perm))
            .map(([href, label]) => (
              <Button key={href} asChild size="sm" variant="outline">
                <Link href={href}>{label}</Link>
              </Button>
            ))}
        </div>
      </form>
      {prov && (
        <ProvenanceStrip
          p={prov}
          exceptionsHref={
            can(member, "finance.exceptions.manage") ? "/finance/exceptions" : undefined
          }
        />
      )}

      {t.submitted === 0 ? (
        <Alert>
          <AlertTitle>No claims in this range yet</AlertTitle>
          <AlertDescription>
            Claims appear after a Diligence report is imported (Finance → Claims, Uploads). Try a
            wider range if one has been.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Claimed"
              value={t.claimed}
              goodWhen="neutral"
              note={`${t.submitted.toLocaleString()} claim activities`}
            />
            <KpiCard
              label="Accepted"
              value={t.acceptedAmount}
              goodWhen="neutral"
              note={`${t.accepted.toLocaleString()} claims, ${rate(t.accepted, t.submitted) ?? "—"}%, with evidence`}
            />
            <KpiCard
              label="Paid (allocated)"
              value={t.paidAllocated}
              goodWhen="neutral"
              note="from reconciled remittances"
            />
            <KpiCard
              label="Outstanding"
              value={t.outstanding}
              goodWhen="neutral"
              note="net less remitted and approved write-offs"
            />
            <KpiCard
              label="Rejected"
              value={t.rejectedAmount}
              goodWhen="neutral"
              note={`${t.rejected.toLocaleString()} claims, ${rate(t.rejected, t.submitted) ?? "—"}%`}
            />
            <KpiCard
              label="Pending"
              value={t.pending}
              goodWhen="neutral"
              note={
                t.noStatus > 0
                  ? `of which ${t.noStatus.toLocaleString()} have no status`
                  : "no evidence of payment or rejection yet"
              }
            />
            <KpiCard
              label="Resubmitted"
              value={t.resubmitted}
              goodWhen="neutral"
              note="claims with a resubmission"
            />
            <KpiCard
              label="Days to pay (average)"
              value={t.avgDaysToPay ?? 0}
              goodWhen="neutral"
              note={
                t.avgDaysToPay === null
                  ? "no paid claims yet"
                  : `90th percentile ${t.p90DaysToPay ?? "—"} days, ${t.paidClaims.toLocaleString()} paid claims`
              }
            />
          </section>
          <p className="text-muted-foreground -mt-3 text-xs">
            Counts in the last three tiles are claims, not amounts. Accepted counts a claim only
            with a remitted amount or a status listed in Workflow settings; claims with neither are
            never assumed accepted.
          </p>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Outstanding by age</CardTitle>
                <CardDescription>Aged from the claim date, as of today.</CardDescription>
              </CardHeader>
              <CardContent>
                {o.ageing.every((a) => a.outstanding === 0) ? (
                  <p className="text-muted-foreground text-sm">
                    Nothing outstanding in this range.
                  </p>
                ) : (
                  <HorizontalBars
                    rows={o.ageing.map((a) => ({
                      label: `${a.bucket} days`,
                      value: a.outstanding,
                      note: `${a.claims.toLocaleString()} claims`,
                    }))}
                  />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Largest open balances by payer</CardTitle>
                <CardDescription>Top 15 payers by outstanding amount.</CardDescription>
              </CardHeader>
              <CardContent>
                {o.payers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No payers in this range.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Payer</TableHead>
                          <TableHead className="text-right">Claims</TableHead>
                          <TableHead className="text-right">Rejected</TableHead>
                          <TableHead className="text-right">Outstanding</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {o.payers.map((p) => (
                          <TableRow key={p.payerId}>
                            <TableCell className="text-sm">{p.payerName ?? p.payerId}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {p.claims.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {p.rejected.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {money(p.outstanding)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
