import Link from "next/link";

import { ProvenanceStrip } from "@/components/finance/provenance-strip";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { PROVISIONAL_LABEL, type ProfitGroupBy } from "@/lib/finance/profitability";
import { buildProvenance } from "@/lib/finance/provenance";
import { currentMonth, monthParam, monthsAgo } from "@/lib/finance/summary";
import { monthEnd } from "@/lib/finance/summary-extras";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Profitability" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; by?: string };
const GROUPS: ReadonlyArray<{ key: ProfitGroupBy; label: string }> = [
  { key: "branch", label: "Branch" },
  { key: "month", label: "Month" },
  { key: "department", label: "Department" },
  { key: "doctor", label: "Doctor" },
];
const dash = (v: number | null) => (v === null ? "—" : money(v));

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.profit.view");
  const sp = await searchParams;
  const from = monthParam(sp.from, monthsAgo(2));
  const to = monthParam(sp.to, currentMonth());
  const range = from <= to ? { from, to } : { from: to, to: from };
  const canComp = can(member, "finance.costs.compensation");
  const requested = GROUPS.find((g) => g.key === sp.by)?.key ?? "branch";
  // by doctor would reveal each doctor's compensation, so it needs that specific permission
  const by: ProfitGroupBy = requested === "doctor" && !canComp ? "branch" : requested;
  const groups = GROUPS.filter((g) => g.key !== "doctor" || canComp);

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const result = await loadProfitability(
    admin,
    member.orgId,
    { from: `${range.from}-01`, to: monthEnd(range.to) },
    by,
  );
  const fresh = await loadFreshness(await createClient());
  const prov = fresh
    ? buildProvenance({ ...fresh, captureEnabled: fresh.captureEnabledFlag }, ["unite", "costs"], {
        from: `${range.from}-01`,
        to: monthEnd(range.to),
      })
    : null;
  const label = groups.find((g) => g.key === by)?.label ?? "Branch";
  const href = (g: ProfitGroupBy) =>
    `/finance/profitability?from=${range.from}&to=${range.to}&by=${g}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Profitability"
        description="Contribution margin and estimated profitability from invoice revenue and the costs Finance maintains. All amounts in AED."
      />

      {result.provisional && (
        <Alert>
          <AlertTitle>
            <Badge variant="warning">{PROVISIONAL_LABEL}</Badge> These figures are not final
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="mt-2">
              A month stops being provisional when Finance approves its costs and every service has
              a cost.
            </p>
          </AlertDescription>
        </Alert>
      )}

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
        <input type="hidden" name="by" value={by} />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <Button key={g.key} asChild size="sm" variant={by === g.key ? "default" : "outline"}>
              <Link href={href(g.key)}>By {g.label.toLowerCase()}</Link>
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

      <Card>
        <CardHeader>
          <CardTitle>By {label.toLowerCase()}</CardTitle>
          <CardDescription>
            Contribution margin = revenue − direct service cost − doctor compensation. Estimated
            profitability also takes the allocated overhead (shown by branch and month only).
            Coverage is the share of revenue that has a service cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No invoice revenue in this range. Costs are loaded under Finance → Costs.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{label}</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Direct cost</TableHead>
                    <TableHead className="text-right">Coverage</TableHead>
                    <TableHead className="text-right">Doctor comp.</TableHead>
                    <TableHead className="text-right">Contribution</TableHead>
                    <TableHead className="text-right">Overhead</TableHead>
                    <TableHead className="text-right">Est. profit</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...result.rows, result.totals].map((r) => (
                    <TableRow key={r.key} className={r.key === "Total" ? "font-medium" : undefined}>
                      <TableCell className="text-sm">{r.key}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.revenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(r.directCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.coverage === null ? "—" : `${Math.round(r.coverage * 100)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dash(r.doctorComp)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dash(r.contributionMargin)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{dash(r.overhead)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {dash(r.estimatedProfit)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.provisional.length === 0 ? (
                          <Badge variant="success">Approved</Badge>
                        ) : (
                          <Badge variant="warning" title={r.provisional.join("; ")}>
                            {PROVISIONAL_LABEL}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-xs">
        Revenue here is invoice net, not Finance-approved recognised revenue. Doctor comparisons
        need the Medical Director&apos;s review: contribution measures say nothing about clinical
        quality.
      </p>
    </div>
  );
}
