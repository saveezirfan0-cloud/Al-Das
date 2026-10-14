import Link from "next/link";

import { KpiTile } from "@/components/charts/kpi-tile";
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
  BAND_LABEL,
  chosenBranch,
  monthParam,
  type Band,
  type DoctorPerformance,
  type Measures,
} from "@/lib/finance/doctor-performance";
import {
  latestReportMonth,
  loadDoctorPerformance,
  loadPerfScope,
} from "@/lib/finance/doctor-performance-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Doctor performance" };
export const dynamic = "force-dynamic";

type Search = { month?: string; branch?: string };

/** Tinted chips (never white text on amber or emerald), one tint per band. */
const BAND_CLASS: Record<Band, string> = {
  achieved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  near: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  moderate: "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  below: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
};

function BandBadge({ band }: { band: Band | null }) {
  if (!band) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent whitespace-nowrap", BAND_CLASS[band])}
    >
      {BAND_LABEL[band]}
    </Badge>
  );
}

const num = "text-right tabular-nums whitespace-nowrap";
const pct = (v: number | null, signed = false) =>
  v === null || !Number.isFinite(v)
    ? "—"
    : `${signed && v > 0 ? "+" : ""}${(v * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
const int = (v: number) => v.toLocaleString("en-GB");

function Signed({ v, children }: { v: number | null; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        v !== null && v > 0 && "text-emerald-700 dark:text-emerald-400",
        v !== null && v < 0 && "text-destructive",
      )}
    >
      {children}
    </span>
  );
}

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

function Cells({ m }: { m: Measures }) {
  return (
    <>
      <TableCell className={num}>{money(m.revenue)}</TableCell>
      <TableCell className={num}>{money(m.previous.revenue)}</TableCell>
      <TableCell className={num}>
        <Signed v={m.changePct}>{pct(m.changePct, true)}</Signed>
      </TableCell>
      <TableCell className={num}>{int(m.patients)}</TableCell>
      <TableCell className={num}>{int(m.unbilledPatients)}</TableCell>
      <TableCell className={num}>{money(m.revenuePerPatient)}</TableCell>
      <TableCell>
        <BandBadge band={m.band} />
      </TableCell>
      <TableCell className={num}>{money(m.expectedRevenue)}</TableCell>
      <TableCell className={num}>
        <Signed v={m.gap}>{money(m.gap)}</Signed>
      </TableCell>
      <TableCell className={num}>{pct(m.achievement)}</TableCell>
      <TableCell className={num}>{int(m.visits)}</TableCell>
      <TableCell className={num}>{int(m.newVisits)}</TableCell>
      <TableCell className={num}>{int(m.followUps)}</TableCell>
    </>
  );
}

const sticky = "bg-card sticky left-0 z-10 min-w-44 max-w-64";

function PerformanceTable({ r }: { r: DoctorPerformance }) {
  const prev = monthTitle(r.previousMonth);
  return (
    <Table>
      <caption className="sr-only">
        Revenue and patients by department and doctor, {monthTitle(r.month)} against {prev}
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead className={sticky}>Department / doctor</TableHead>
          <TableHead className="text-right">Revenue</TableHead>
          <TableHead className="text-right">Prev. month</TableHead>
          <TableHead className="text-right">Change %</TableHead>
          <TableHead className="text-right">Patients</TableHead>
          <TableHead className="text-right">Unbilled</TableHead>
          <TableHead className="text-right">Revenue / patient</TableHead>
          <TableHead>Band</TableHead>
          <TableHead className="text-right">Expected</TableHead>
          <TableHead className="text-right">Gap</TableHead>
          <TableHead className="text-right">Achievement</TableHead>
          <TableHead className="text-right">Visits</TableHead>
          <TableHead className="text-right">New</TableHead>
          <TableHead className="text-right">Follow-ups</TableHead>
        </TableRow>
      </TableHeader>
      {r.departments.map((d) => (
        <TableBody key={d.key} className="border-b-2">
          <TableRow className="bg-muted/50 font-semibold">
            <TableHead
              scope="rowgroup"
              className={cn(sticky, "bg-muted text-foreground h-auto py-2")}
            >
              {d.label}
              <span className="text-muted-foreground block text-xs font-normal">
                {d.doctors === 1 ? "1 doctor" : `${d.doctors} doctors`}
                {d.share !== null && `, ${pct(d.share)} of revenue`}
              </span>
            </TableHead>
            <Cells m={d} />
          </TableRow>
          {d.doctorRows.map((doc) => (
            <TableRow key={doc.key}>
              <TableHead
                scope="row"
                className={cn(sticky, "text-foreground h-auto py-2 pl-5 font-normal")}
              >
                {doc.name}
              </TableHead>
              <Cells m={doc} />
            </TableRow>
          ))}
        </TableBody>
      ))}
      <TableBody>
        <TableRow className="bg-muted/50 font-semibold">
          <TableHead scope="row" className={cn(sticky, "bg-muted text-foreground h-auto py-2")}>
            Clinic total
            <span className="text-muted-foreground block text-xs font-normal">
              {r.total.doctors === 1 ? "1 doctor" : `${r.total.doctors} doctors`}, each patient once
            </span>
          </TableHead>
          <Cells m={r.total} />
        </TableRow>
      </TableBody>
    </Table>
  );
}

export default async function DoctorPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const thisMonth = `${todayIn(member.org.timezone).slice(0, 7)}-01`;

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadPerfScope(admin, member);
  const branch = chosenBranch(sp.branch, scope.allowed);
  const month =
    monthParam(sp.month) ??
    (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
    thisMonth;
  const r = await loadDoctorPerformance(admin, member.orgId, {
    month,
    branch,
    allowed: scope.allowed,
  });
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });

  const title = monthTitle(month);
  const prevTitle = monthTitle(r.previousMonth);
  const link = (m: string) =>
    `/finance/doctor-performance?${new URLSearchParams({ month: m.slice(0, 7), ...(branch ? { branch } : {}) })}`;
  const excel = `/api/finance/doctor-performance?${new URLSearchParams({ month: month.slice(0, 7), ...(branch ? { branch } : {}) })}`;
  const s = r.settings;
  const t = r.total;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Doctor performance"
        description="Revenue, patients and revenue per patient by department and doctor, this month against the previous month, from the Unite collection report. Activity measures, not a judgement of clinical quality."
      >
        {can(member, "finance.targets.manage") && (
          <Button asChild variant="outline">
            <Link href="/finance/flash/settings#performance">Target and bands</Link>
          </Button>
        )}
        {r.hasData && (
          <Button asChild variant="outline">
            <a href={excel}>Download Excel</a>
          </Button>
        )}
      </PageHeader>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Month</span>
          <Input name="month" type="month" defaultValue={month.slice(0, 7)} className="w-44" />
        </label>
        {scope.branches.length > (scope.allowed === null ? 0 : 1) ? (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Branch</span>
            <select
              name="branch"
              defaultValue={branch ?? ""}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="">
                {scope.allowed === null ? "All branches" : "All your branches"}
              </option>
              {scope.branches.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button type="submit" variant="secondary">
          Show
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={link(addMonths(month, -1))}>Previous month</Link>
        </Button>
        {month < thisMonth && (
          <Button asChild variant="ghost" size="sm">
            <Link href={link(addMonths(month, 1))}>Next month</Link>
          </Button>
        )}
      </form>

      {!r.hasData ? (
        <Card>
          <CardHeader>
            <CardTitle>No Unite report data for {title} yet</CardTitle>
            <CardDescription>
              This page is built from the Unite Daily Collection report. Finance uploads it under{" "}
              {can(member, "finance.revenue.import") ? (
                <Link className="text-primary underline" href="/finance/upload">
                  Finance, Upload
                </Link>
              ) : (
                "Finance, Upload (/finance/upload)"
              )}
              ; once a report covering {title} is committed, the figures appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {(!r.coverage.full || !r.previousCoverage.full) && (
            <Alert>
              <AlertTitle>Part of a month is missing</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {!r.coverage.full && (
                    <li>
                      {title} is only partly covered ({r.coverage.label}). Compare with care.
                    </li>
                  )}
                  {!r.previousCoverage.full && (
                    <li>
                      {prevTitle} is only partly covered ({r.previousCoverage.label}), so the change
                      against it can mislead.
                    </li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <section
            aria-label="Headline figures"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiTile
              label={`Revenue, ${title} (AED)`}
              value={Math.round(t.revenue)}
              hint={
                t.changePct === null
                  ? `No ${prevTitle} revenue to compare`
                  : `${pct(t.changePct, true)} vs ${prevTitle}`
              }
            />
            <KpiTile
              label="Patients"
              value={t.patients}
              hint={
                t.patientsChangePct === null
                  ? `${int(t.unbilledPatients)} without billing`
                  : `${pct(t.patientsChangePct, true)} vs ${prevTitle}; ${int(t.unbilledPatients)} without billing`
              }
            />
            <KpiTile
              label="Revenue per patient (AED)"
              value={t.revenuePerPatient}
              hint={`Target ${int(s.target)}${t.band ? `: ${BAND_LABEL[t.band]}` : ""}`}
            />
            <KpiTile
              label="Follow-ups per patient"
              value={t.followUpsPerPatient}
              hint={`${int(t.followUps)} repeat visits in the month`}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                By department and doctor, {title} against {prevTitle}
              </CardTitle>
              <CardDescription>
                Revenue is Unite net billing (after discount, before VAT). A department and the
                clinic count each patient once, so their patients are not the sum of the doctors.
                Bands: Achieved from {int(s.target)}, Near Target from {int(s.near)}, Moderate from{" "}
                {int(s.moderate)}, otherwise Below Target (AED per patient).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PerformanceTable r={r} />
            </CardContent>
          </Card>

          <footer className="text-muted-foreground flex flex-col gap-1 text-xs">
            <span>
              Total net for {title}
              {branch ? ` (${scope.branches.find((b) => b.code === branch)?.name ?? branch})` : ""}:
              AED {money(r.reconciliation.total)}, every current report row
              {t.cancelledVisits > 0
                ? `, including ${int(t.cancelledVisits)} cancelled ${t.cancelledVisits === 1 ? "visit" : "visits"} as Unite does`
                : ""}
              .
            </span>
            <span>Covered dates: {r.coverage.label}.</span>
            <span className={cn(!r.reconciliation.matches && "text-destructive font-medium")}>
              Reconciliation: departments AED {money(r.reconciliation.departmentsSum)}{" "}
              {r.reconciliation.matches ? "=" : "≠"} total AED {money(r.reconciliation.total)}.
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
