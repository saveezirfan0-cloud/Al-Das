import Link from "next/link";

import { KpiCard } from "@/components/finance/kpi-card";
import { ProvenanceStrip } from "@/components/finance/provenance-strip";
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
import { loadFreshness } from "@/lib/finance/freshness";
import { money } from "@/lib/finance/format";
import { loadProfitability } from "@/lib/finance/profit-server";
import { PROVISIONAL_LABEL } from "@/lib/finance/profitability";
import { buildProvenance } from "@/lib/finance/provenance";
import { currentMonth, monthParam, monthsAgo } from "@/lib/finance/summary";
import { ageingTotals, monthEnd, type AgeingRow } from "@/lib/finance/summary-extras";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Branches" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string };
type Row = {
  branch_code: string | null;
  generated: number | null;
  claimed: number | null;
  accepted: number | null;
  paid_allocated: number | null;
  rejected: number | null;
  outstanding: number | null;
  self_pay_collected: number | null;
  status_unknown_claims: number | null;
};
const add = (a: number, b: number | null) => a + Number(b ?? 0);

export default async function BranchesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.view");
  const sp = await searchParams;
  const from = monthParam(sp.from, monthsAgo(2));
  const to = monthParam(sp.to, currentMonth());
  const range = from <= to ? { from, to } : { from: to, to: from };
  const supabase = await createClient();

  const [{ data }, { data: ageing }, { data: branches }, fresh] = await Promise.all([
    supabase
      .from("v_fin_monthly_measures")
      .select(
        "branch_code, generated, claimed, accepted, paid_allocated, rejected, outstanding, self_pay_collected, status_unknown_claims",
      )
      .gte("month", `${range.from}-01`)
      .lte("month", `${range.to}-01`),
    supabase
      .from("v_fin_receivables_ageing")
      .select("branch_code, bucket, claim_activities, outstanding"),
    supabase.from("fin_ref_branches").select("code, name"),
    loadFreshness(supabase),
  ]);

  const names = new Map((branches ?? []).map((b) => [b.code, b.name]));
  const byBranch = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) {
    const k = r.branch_code ?? "";
    byBranch.set(k, [...(byBranch.get(k) ?? []), r]);
  }
  const sum = (rows: Row[], f: keyof Row) =>
    rows.reduce((n, r) => add(n, r[f] as number | null), 0);
  const aged = new Map<string, AgeingRow[]>();
  for (const r of (ageing ?? []) as Array<AgeingRow & { branch_code: string | null }>) {
    const k = r.branch_code ?? "";
    aged.set(k, [...(aged.get(k) ?? []), r]);
  }

  // Estimated profitability is shown only to people who may see it, and always labelled
  const canProfit = can(member, "finance.profit.view");
  const profit = canProfit
    ? await loadProfitability(
        createAdminClient(member.userId), // service role AFTER the permission check
        member.orgId,
        { from: `${range.from}-01`, to: monthEnd(range.to) },
        "branch",
      )
    : null;
  const profitBy = new Map((profit?.rows ?? []).map((r) => [r.key, r]));

  const keys = [...byBranch.keys()].sort((x, y) => (x || "~").localeCompare(y || "~"));
  const prov = fresh
    ? buildProvenance(
        { ...fresh, captureEnabled: fresh.captureEnabledFlag },
        ["unite", "diligence", "remittance"],
        { from: `${range.from}-01`, to: monthEnd(range.to) },
      )
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Branches"
        description="Revenue stages, insurance balances and estimated profitability for Palm Jumeirah, Meadows and Golden Mile. The branch comes from the invoice's clinic."
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
      </form>
      {prov && (
        <ProvenanceStrip
          p={prov}
          exceptionsHref={
            can(member, "finance.exceptions.manage") ? "/finance/exceptions" : undefined
          }
        />
      )}

      {keys.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No figures in this range yet. They appear once invoices are captured and a Diligence
            claims report is imported.
          </CardContent>
        </Card>
      ) : (
        keys.map((k) => {
          const rows = byBranch.get(k)!;
          const name = k ? (names.get(k) ?? k) : "Unknown branch";
          const pl = profitBy.get(k || "Unknown branch");
          const buckets = ageingTotals(aged.get(k) ?? []);
          return (
            <Card key={k || "unknown"}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {name}
                  {k && <span className="text-muted-foreground font-mono text-xs">{k}</span>}
                  {!k && <Badge variant="warning">needs a clinic-to-branch mapping</Badge>}
                </CardTitle>
                <CardDescription>
                  {sum(rows, "status_unknown_claims") > 0
                    ? `${sum(rows, "status_unknown_claims").toLocaleString()} claims have no status yet and are not counted as accepted.`
                    : "Accepted counts only claims with evidence: a remitted amount or a status you listed as accepted."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <KpiCard label="Generated" value={sum(rows, "generated")} goodWhen="neutral" />
                  <KpiCard label="Claimed" value={sum(rows, "claimed")} goodWhen="neutral" />
                  <KpiCard label="Accepted" value={sum(rows, "accepted")} goodWhen="neutral" />
                  <KpiCard
                    label="Paid (allocated)"
                    value={sum(rows, "paid_allocated")}
                    goodWhen="neutral"
                  />
                  <KpiCard label="Rejected" value={sum(rows, "rejected")} goodWhen="neutral" />
                  <KpiCard
                    label="Outstanding"
                    value={sum(rows, "outstanding")}
                    goodWhen="neutral"
                  />
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  <span className="text-muted-foreground font-medium">Outstanding by age</span>
                  {buckets.map((b) => (
                    <span key={b.bucket}>
                      {b.bucket} days: {money(b.outstanding)}
                    </span>
                  ))}
                </div>
                {pl && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Estimated profitability</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">Contribution</TableHead>
                        <TableHead className="text-right">Est. profit</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="text-xs">Invoice revenue less costs</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(pl.revenue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pl.contributionMargin === null ? "—" : money(pl.contributionMargin)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pl.estimatedProfit === null ? "—" : money(pl.estimatedProfit)}
                        </TableCell>
                        <TableCell>
                          {pl.provisional.length === 0 ? (
                            <Badge variant="success">Approved</Badge>
                          ) : (
                            <Badge variant="warning" title={pl.provisional.join("; ")}>
                              {PROVISIONAL_LABEL}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
      <p className="text-muted-foreground text-xs">
        Operational branch is not the legal billing entity: legal entity, official invoice number
        and insurance arrangements are unchanged.{" "}
        <Link href="/finance/summary" className="underline underline-offset-2">
          Monthly summary
        </Link>
      </p>
    </div>
  );
}
