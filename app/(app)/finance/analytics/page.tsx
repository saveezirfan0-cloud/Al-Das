import Link from "next/link";

import { GroupedBars } from "@/components/finance/bars";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { todayIn } from "@/lib/finance/action-support";
import {
  describeMix,
  parseBillingMix,
  parseTrend,
  periodLabel,
  readAnalyticsFilters,
  trendTotals,
  UNMAPPED,
  type MixView,
} from "@/lib/finance/billing-mix";
import { doctorBasisNote } from "@/lib/finance/blueprint-settings";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Billing mix and trends" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; branch?: string; grain?: string };

/** Segment colours in category order; Unmapped is always grey. */
const COLOURS = [
  "bg-sky-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-indigo-500",
];
const colour = (categories: string[], c: string) =>
  c === UNMAPPED ? "bg-muted-foreground/40" : COLOURS[categories.indexOf(c) % COLOURS.length];
const pct = (s: number | null) => (s === null ? "—" : `${(s * 100).toFixed(0)}%`);

function MixBar({ row, categories }: { row: MixView; categories: string[] }) {
  const parts = categories
    .map((c) => ({ c, s: row.categoryShares[c] ?? null }))
    .filter((p): p is { c: string; s: number } => p.s !== null && p.s > 0);
  const summary = parts.map((p) => `${p.c} ${pct(p.s)}`).join(", ");
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <div
        className="bg-muted flex h-2.5 w-full overflow-hidden rounded"
        aria-hidden
        title={summary}
      >
        {parts.map((p) => (
          <span
            key={p.c}
            className={`block h-full ${colour(categories, p.c)}`}
            style={{ width: `${Math.min(100, p.s * 100)}%` }}
          />
        ))}
      </div>
      <span className="text-muted-foreground text-[10px] leading-tight">{summary || "—"}</span>
    </div>
  );
}

export default async function BillingAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const f = readAnalyticsFilters((k) => sp[k as keyof Search], todayIn(member.org.timezone));

  const admin = createAdminClient(); // service role AFTER the permission check
  const [mixRes, trendRes] = await Promise.all([
    admin.rpc("fin_billing_mix", {
      p_org_id: member.orgId,
      p_from: f.from,
      p_to: f.to,
      p_branch: f.branch ?? undefined,
    }),
    admin.rpc("fin_revenue_trend", {
      p_org_id: member.orgId,
      p_from: f.from,
      p_to: f.to,
      p_grain: f.grain,
      p_branch: f.branch ?? undefined,
    }),
  ]);
  const failed = Boolean(mixRes.error || trendRes.error);
  const mix = parseBillingMix(mixRes.data);
  const { categories, clinic, rows } = describeMix(mix);
  const trend = parseTrend(trendRes.data);
  const totals = trendTotals(trend.rows);
  const unmappedShare = clinic?.categoryShares[UNMAPPED] ?? null;

  const params = (kind: string) =>
    new URLSearchParams({
      kind,
      from: f.from,
      to: f.to,
      grain: f.grain,
      ...(f.branch ? { branch: f.branch } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing mix and trends"
        description="How each doctor bills (consultation, lab, radiology, procedures; insurance or self-pay) against the clinic as a whole, and revenue by week or month next to the same period last year. Activity measures, not a judgement of clinical quality."
      >
        <Button asChild variant="outline">
          <a href={`/api/finance/analytics?${params("mix")}`}>Mix CSV</a>
        </Button>
        <Button asChild variant="outline">
          <a href={`/api/finance/analytics?${params("trend")}`}>Trend CSV</a>
        </Button>
      </PageHeader>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">From</span>
          <Input name="from" type="date" defaultValue={f.from} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">To</span>
          <Input name="to" type="date" defaultValue={f.to} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Branch</span>
          <Input
            name="branch"
            placeholder="All"
            defaultValue={f.branch ?? ""}
            maxLength={4}
            className="w-24"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Trend by</span>
          <select
            name="grain"
            defaultValue={f.grain}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="month">Month</option>
            <option value="week">Week</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {failed && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the figures</AlertTitle>
          <AlertDescription>Try again in a moment.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Doctor billing mix</CardTitle>
          <CardDescription>
            Net of current invoice lines (deleted invoices excluded) by service category, as on the
            Revenue page. Patients are counted once per doctor. &ldquo;Differs most&rdquo; is the
            category where the doctor&rsquo;s share is furthest from the clinic&rsquo;s, in
            percentage points. {doctorBasisNote(mix.doctorBasis)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {unmappedShare !== null && unmappedShare > 0 && (
            <p className="text-sm">
              <Badge variant="warning">{pct(unmappedShare)} unmapped</Badge>{" "}
              <span className="text-muted-foreground">
                Some billed items have no service category yet
                {can(member, "finance.reference.manage") ? (
                  <>
                    {"; set it under "}
                    <Link href="/finance/reference" className="underline">
                      Reference data
                    </Link>
                  </>
                ) : (
                  "; Finance sets it under Reference data"
                )}
                .
              </span>
            </p>
          )}
          {!clinic || rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No invoices in this period yet.</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-3 text-xs" aria-label="Service categories">
                {categories.map((c) => (
                  <li key={c} className="flex items-center gap-1">
                    <span className={`inline-block size-2 rounded-sm ${colour(categories, c)}`} />
                    {c}
                  </li>
                ))}
              </ul>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Doctor</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Patients</TableHead>
                      <TableHead className="text-right">Per patient</TableHead>
                      <TableHead className="text-right">Lines per invoice</TableHead>
                      <TableHead>Mix</TableHead>
                      <TableHead className="text-right">Insurance</TableHead>
                      <TableHead>Differs most</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...rows, clinic].map((r) => {
                      const isClinic = r === clinic;
                      return (
                        <TableRow
                          key={isClinic ? "clinic" : (r.doctorId ?? "none")}
                          className={isClinic ? "bg-muted/40 font-medium" : undefined}
                        >
                          <TableCell className="text-sm">
                            {isClinic
                              ? "All doctors"
                              : (r.doctorName ?? r.doctorId ?? "No doctor on the invoice")}
                            {!isClinic && r.department && (
                              <span className="text-muted-foreground block text-xs">
                                {r.department}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {money(r.net)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {r.patients.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {money(r.arpp)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {r.linesPerInvoice === null ? "—" : r.linesPerInvoice.toFixed(1)}
                          </TableCell>
                          <TableCell>
                            <MixBar row={r} categories={categories} />
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {pct(r.insuranceShare)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {isClinic || !r.largest
                              ? "—"
                              : `${r.largest.category} ${r.largest.points > 0 ? "+" : ""}${r.largest.points.toFixed(1)} pts`}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Seasonality</CardTitle>
          <CardDescription>
            Invoice net (as on the daily flash) by {f.grain}, next to the same {f.grain} last year
            {f.grain === "week" ? " (52 weeks earlier, so the weekdays line up)" : ""}. Periods at
            either end are cut to the range, and so is last year. Patients are counted once per{" "}
            {f.grain}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{money(totals.current.net)}</span> net in
            this range
            {totals.lastYear ? (
              <>
                {" "}
                <span className="text-muted-foreground">
                  versus {money(totals.lastYear.net)} in the same periods last year
                </span>
                {totals.changePct !== null && (
                  <>
                    {" "}
                    <Badge variant={totals.changePct >= 0 ? "success" : "warning"}>
                      {totals.changePct > 0 ? "+" : ""}
                      {totals.changePct}%
                    </Badge>
                  </>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">
                . Last year is not fully on record
                {trend.historyFrom ? ` (first invoice on record: ${trend.historyFrom})` : ""}, so
                the totals are not compared
              </span>
            )}
            .
          </p>
          {trend.rows.length > 0 && (
            <GroupedBars
              series={trend.rows.map((r) => ({
                label: f.grain === "month" ? r.period.slice(0, 7) : r.period,
                a: r.net,
                b: r.lastYear?.net ?? null,
              }))}
              labels={{ a: "This period", b: "Last year" }}
            />
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{f.grain === "week" ? "Week" : "Month"}</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Last year</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead className="text-right">Invoices</TableHead>
                  <TableHead className="text-right">Patients</TableHead>
                  <TableHead className="text-right">Patients last year</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trend.rows.map((r) => (
                  <TableRow key={r.period}>
                    <TableCell className="text-sm">
                      {periodLabel(trend.grain, r.period)}
                      <span className="text-muted-foreground block text-[10px]">
                        {r.from} to {r.to}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(r.net)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.lastYear ? money(r.lastYear.net) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {r.changePct === null ? (
                        "—"
                      ) : (
                        <Badge variant={r.changePct >= 0 ? "success" : "warning"}>
                          {r.changePct > 0 ? "+" : ""}
                          {r.changePct}%
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.invoices}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.patients}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.lastYear ? r.lastYear.patients : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
