import Link from "next/link";

import { GroupedBars, HorizontalBars } from "@/components/finance/bars";
import { KpiCard } from "@/components/finance/kpi-card";
import { SetupChecklist } from "@/components/finance/setup-checklist";
import { PageHeader } from "@/components/shell/page-header";
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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadFreshness } from "@/lib/finance/freshness";
import { ago, money } from "@/lib/finance/format";
import { readinessSteps, isReady } from "@/lib/finance/readiness";
import {
  RANGE_PRESETS,
  REVENUE_GROUPS,
  SUMMARY_COLUMNS,
  activeRange,
  currentMonth,
  groupRevenue,
  monthParam,
  monthSpan,
  monthlySeries,
  monthsAgo,
  previousRange,
  rangeFor,
  splitPeriods,
  totals,
  type RevenueGroup,
  type RevenueRow,
  type SummaryRow,
} from "@/lib/finance/summary";
import {
  ageingTotals,
  claimInRange,
  claimsByPayer,
  monthEnd,
  topDenials,
  type AgeingRow,
  type ClaimsStatusRow,
  type DenialRow,
} from "@/lib/finance/summary-extras";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Monthly summary" };
export const dynamic = "force-dynamic";

type Search = {
  from?: string;
  to?: string;
  branch?: string;
  group?: string;
  department?: string;
  doctor?: string;
};
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 80);
const HEAD: Record<(typeof SUMMARY_COLUMNS)[number], string> = {
  generated: "Generated",
  claimed: "Claimed",
  remitted: "Remitted",
  rejected: "Rejected",
  outstanding: "Outstanding",
  self_pay_collected: "Self-pay collected",
};
/** Which direction is good news for each KPI. */
const GOOD_WHEN = {
  generated: "up",
  claimed: "up",
  remitted: "up",
  rejected: "down",
  outstanding: "down",
  self_pay_collected: "up",
} as const;

const selectClass = "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export default async function SummaryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.view");
  const sp = await searchParams;
  const from = monthParam(sp.from, monthsAgo(11));
  const to = monthParam(sp.to, currentMonth());
  const range = from <= to ? { from, to } : { from: to, to: from };
  const prev = previousRange(range.from, range.to);
  const group: RevenueGroup = REVENUE_GROUPS.some((g) => g.key === sp.group)
    ? (sp.group as RevenueGroup)
    : "department";
  const branch = safe(sp.branch).toUpperCase();
  const supabase = await createClient();

  let sq = supabase
    .from("v_fin_monthly_summary")
    .select(
      "month, branch_code, generated, claimed, remitted, rejected, outstanding, self_pay_collected",
    )
    .gte("month", `${prev.from}-01`)
    .lte("month", `${range.to}-01`)
    .order("month", { ascending: false })
    .order("branch_code");
  if (branch) sq = sq.eq("branch_code", branch);

  let rq = supabase
    .from("v_fin_revenue_monthly")
    .select(
      "branch_code, department, doctor_name, doctor_dha_id, service_category, gross, discount, net, vat",
    )
    .gte("month", `${range.from}-01`)
    .lte("month", `${range.to}-01`)
    .limit(20_000);
  if (branch) rq = rq.eq("branch_code", branch);
  if (safe(sp.department)) rq = rq.eq("department", safe(sp.department));
  if (safe(sp.doctor)) rq = rq.eq("doctor_dha_id", safe(sp.doctor));

  let aq = supabase
    .from("v_fin_receivables_ageing")
    .select("bucket, claim_activities, outstanding");
  if (branch) aq = aq.eq("branch_code", branch);
  let cq = supabase
    .from("v_fin_claims_status")
    .select(
      "claim_year, claim_month, payer_id, submitted, accepted, rejected, pending, resubmitted, net, remitted, rejected_amount",
    )
    .gte("claim_year", Number(range.from.slice(0, 4)))
    .lte("claim_year", Number(range.to.slice(0, 4)));
  if (branch) cq = cq.eq("branch_code", branch);
  const dq = supabase
    .from("v_fin_denials")
    .select("denial_type, last_denial_code, claim_activities, rejected_amount")
    .limit(5000);

  const [
    { data: summary },
    { data: revenue },
    { data: ageing },
    { data: claimStatus },
    { data: denials },
    { data: branches },
    { data: doctors },
    { data: payers },
    freshness,
  ] = await Promise.all([
    sq,
    rq,
    aq,
    cq,
    dq,
    supabase.from("fin_ref_branches").select("code, name").eq("active", true).order("code"),
    supabase.from("fin_ref_doctors").select("dha_id, name, department").eq("active", true),
    supabase.from("fin_ref_payers").select("payer_id, payer_name"),
    loadFreshness(supabase),
  ]);

  const { current, previous } = splitPeriods((summary ?? []) as SummaryRow[], range.from);
  const sum = totals(current);
  const prevSum = totals(previous);
  const hasPrev = previous.length > 0;
  const series = monthlySeries(current);
  const groups = groupRevenue((revenue ?? []) as RevenueRow[], group);
  const ageingRows = ageingTotals((ageing ?? []) as AgeingRow[]);
  const claimRows = ((claimStatus ?? []) as ClaimsStatusRow[]).filter((r) =>
    claimInRange(r, range.from, range.to),
  );
  const payerNames = new Map((payers ?? []).map((p) => [p.payer_id, p.payer_name]));
  const byPayer = claimsByPayer(claimRows, payerNames);
  const denialRows = topDenials((denials ?? []) as DenialRow[]);
  const departments = [
    ...new Set((doctors ?? []).map((d) => d.department?.trim()).filter((d): d is string => !!d)),
  ].sort();

  const allowed = [
    "finance.capture.manage",
    "finance.reference.manage",
    "finance.claims.import",
  ].filter((p) => can(member, p as Parameters<typeof can>[1]));
  const steps = freshness ? readinessSteps(freshness) : null;
  const noData = (summary ?? []).length === 0;

  const qs = (extra: Record<string, string>) =>
    new URLSearchParams(
      Object.entries({
        branch: sp.branch,
        department: sp.department,
        doctor: sp.doctor,
        group: sp.group,
        ...extra,
      }).filter(([, v]) => v) as [string, string][],
    ).toString();
  const csv = new URLSearchParams({
    from: range.from,
    to: range.to,
    ...(branch ? { branch } : {}),
  }).toString();
  const active = activeRange(range.from, range.to);
  const groupLabel = REVENUE_GROUPS.find((g) => g.key === group)?.label ?? "Department";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Monthly summary"
        description="Generated, claimed, remitted, rejected and outstanding, by month and branch. One definition for every number, all amounts in AED."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/finance/summary?${csv}`}>Download CSV</Link>
        </Button>
      </PageHeader>

      {freshness && (
        <p className="text-muted-foreground text-xs">
          Data as of: Unite capture{" "}
          {freshness.captureEnabled ? ago(freshness.lastCaptureAt) : "is off"} · Diligence import{" "}
          {ago(freshness.lastImportAt)} · {freshness.invoiceCount.toLocaleString()} invoices,{" "}
          {freshness.claimCount.toLocaleString()} claim activities
          {freshness.openExceptions > 0 && (
            <>
              {" · "}
              <Link href="/finance/exceptions" className="underline underline-offset-2">
                {freshness.openExceptions.toLocaleString()} open exceptions
              </Link>
            </>
          )}
        </p>
      )}

      {steps && !isReady(steps) && noData && <SetupChecklist steps={steps} allowed={allowed} />}

      <div className="flex flex-wrap items-center gap-2" aria-label="Quick ranges">
        {RANGE_PRESETS.map((p) => {
          const r = rangeFor(p.key);
          return (
            <Button
              key={p.key}
              asChild
              size="sm"
              variant={active === p.key ? "default" : "outline"}
            >
              <Link href={`/finance/summary?${qs({ from: r.from, to: r.to })}`}>{p.label}</Link>
            </Button>
          );
        })}
        <Button asChild size="sm" variant="ghost">
          <Link href="/finance/summary">Reset</Link>
        </Button>
      </div>

      <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="From month">
          <input
            name="from"
            type="month"
            defaultValue={range.from}
            className={selectClass}
            aria-label="From month"
          />
        </Field>
        <Field label="To month">
          <input
            name="to"
            type="month"
            defaultValue={range.to}
            className={selectClass}
            aria-label="To month"
          />
        </Field>
        <Field label="Branch">
          <select name="branch" defaultValue={branch} className={selectClass}>
            <option value="">All branches</option>
            {(branches ?? []).map((b) => (
              <option key={b.code} value={b.code}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Department">
          <select
            name="department"
            defaultValue={safe(sp.department)}
            className={selectClass}
            disabled={departments.length === 0}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Doctor">
          <select
            name="doctor"
            defaultValue={safe(sp.doctor)}
            className={selectClass}
            disabled={(doctors ?? []).length === 0}
          >
            <option value="">All doctors</option>
            {(doctors ?? [])
              .slice()
              .sort((a, b) => (a.name ?? a.dha_id).localeCompare(b.name ?? b.dha_id))
              .map((d) => (
                <option key={d.dha_id} value={d.dha_id}>
                  {d.name ?? d.dha_id}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Revenue grouped by">
          <select name="group" defaultValue={group} className={selectClass}>
            {REVENUE_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="secondary" className="sm:w-32">
          Apply
        </Button>
      </form>

      <section aria-label="Headline numbers" className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUMMARY_COLUMNS.map((c) => (
          <KpiCard
            key={c}
            label={HEAD[c]}
            value={sum[c]}
            previous={hasPrev ? prevSum[c] : null}
            goodWhen={GOOD_WHEN[c]}
          />
        ))}
      </section>
      {monthSpan(range.from, range.to) > 0 && (
        <p className="text-muted-foreground -mt-4 text-xs">
          {range.from} to {range.to}
          {hasPrev ? `, compared with ${prev.from} to ${prev.to}` : ""}. Department and doctor
          filters apply to the revenue breakdown only; the claim figures are not split that way.
        </p>
      )}

      {series.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Generated vs remitted</CardTitle>
            <CardDescription>
              What was invoiced against what insurers have paid, month by month.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GroupedBars
              series={series.map((s) => ({ label: s.month, a: s.generated, b: s.remitted }))}
              labels={{ a: "Generated", b: "Remitted" }}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>By month and branch</CardTitle>
          <CardDescription>
            Generated = invoice net (not deleted). Claimed, remitted, rejected and outstanding come
            from Diligence claims, by transaction month. Click a month to see its invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {current.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {noData
                ? "Nothing has been captured or imported yet, so there are no figures to show. The checklist above lists what to set up."
                : "No figures in this range. Try a wider range or reset the filters."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Branch</TableHead>
                  {SUMMARY_COLUMNS.map((c) => (
                    <TableHead key={c} className="text-right">
                      {HEAD[c]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.map((r) => {
                  const ym = r.month.slice(0, 7);
                  const drill = new URLSearchParams({
                    from: `${ym}-01`,
                    to: monthEnd(ym),
                    ...(r.branch_code ? { branch: r.branch_code } : {}),
                  }).toString();
                  return (
                    <TableRow key={`${r.month}-${r.branch_code}`}>
                      <TableCell className="text-xs">
                        <Link
                          href={`/finance/invoices?${drill}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {ym}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{r.branch_code ?? "unknown"}</TableCell>
                      {SUMMARY_COLUMNS.map((c) => (
                        <TableCell key={c} className="text-right tabular-nums">
                          {money(r[c])}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">
                    Total
                  </TableCell>
                  {SUMMARY_COLUMNS.map((c) => (
                    <TableCell key={c} className="text-right font-medium tabular-nums">
                      {money(sum[c])}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outstanding by age</CardTitle>
            <CardDescription>
              Net minus remitted and approved write-offs, aged from the claim&apos;s transaction
              date. Always as of today, whatever the range.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {ageingRows.every((r) => r.outstanding === 0) ? (
              <p className="text-muted-foreground text-sm">
                Nothing outstanding yet. This fills once a Diligence report is imported.
              </p>
            ) : (
              <HorizontalBars
                rows={ageingRows.map((r) => ({
                  label: `${r.bucket} days`,
                  value: r.outstanding,
                  note: `${r.claimActivities.toLocaleString()} claims`,
                }))}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top denial reasons</CardTitle>
            <CardDescription>
              By rejected amount, across all claims (not limited to the range).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {denialRows.length === 0 ? (
              <p className="text-muted-foreground text-sm">No rejected claims.</p>
            ) : (
              <HorizontalBars
                tone="danger"
                rows={denialRows.map((d) => ({
                  label: d.label,
                  value: d.amount,
                  note: `${d.claimActivities.toLocaleString()} claims`,
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Claims by payer</CardTitle>
          <CardDescription>
            Claim activities in the range, with how many were accepted, rejected or are still
            pending.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {byPayer.length === 0 ? (
            <p className="text-muted-foreground text-sm">No claim activities in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payer</TableHead>
                  <TableHead className="text-right">Submitted</TableHead>
                  <TableHead className="text-right">Accepted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Rejection rate</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byPayer.slice(0, 50).map((p) => (
                  <TableRow key={p.payer}>
                    <TableCell className="text-sm">{p.payer}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.submitted}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.accepted}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.rejected}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.pending}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.rejectionRate === null ? "—" : `${p.rejectionRate}%`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.remitted)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Revenue by {groupLabel.toLowerCase()}</CardTitle>
          <CardDescription>
            Invoice lines of current, non-deleted invoices, in the same date range and filters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-muted-foreground text-sm">No revenue in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupLabel}</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.slice(0, 200).map((g) => (
                  <TableRow key={g.label}>
                    <TableCell className="text-sm">{g.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.gross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.discount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.vat)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
