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
  PAY_STATUS_LABEL,
  PROVISIONAL_LABEL,
  type ClinicGroup,
  type ClinicLevels,
  type DoctorLine,
  type Level,
} from "@/lib/finance/contribution";
import { loadContribution, loadRefDoctors } from "@/lib/finance/contribution-server";
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

import { LinkDoctor, UnlinkDoctor } from "./doctor-links";

export const metadata = { title: "Contribution" };
export const dynamic = "force-dynamic";

type Search = { month?: string; branch?: string };

const num = "text-right tabular-nums whitespace-nowrap";
const sticky = "bg-card sticky left-0 z-10 min-w-44 max-w-64";
const pct = (v: number | null) =>
  v === null ? "—" : `${(Math.floor(v * 1000) / 10).toLocaleString("en-GB")}%`;

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

/** A contribution figure: withheld (would show one doctor's pay), unknown, or the amount. */
function Figure({ v, withheld }: { v: number | null; withheld?: boolean }) {
  if (withheld)
    return (
      <span
        className="text-muted-foreground"
        title="Withheld: it would show an individual doctor's pay"
      >
        Withheld
      </span>
    );
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return <span className={cn(v < 0 && "text-destructive")}>{money(v)}</span>;
}

function LevelCells({ l, pay }: { l: Level; pay: boolean }) {
  return (
    <>
      <TableCell className={num}>{money(l.revenue)}</TableCell>
      <TableCell className={num}>{pct(l.coverage)}</TableCell>
      {pay && <TableCell className={num}>{money(l.pay)}</TableCell>}
      <TableCell className={num}>{money(l.charges)}</TableCell>
      <TableCell className={num}>
        <Figure v={l.contribution} withheld={l.withheld} />
      </TableCell>
    </>
  );
}

function DoctorCells({ d, pay }: { d: DoctorLine; pay: boolean }) {
  return (
    <>
      <TableCell className={num}>{money(d.revenue)}</TableCell>
      <TableCell className="text-right whitespace-nowrap">
        {d.status === "linked" ? (
          <span className="text-muted-foreground text-xs">{PAY_STATUS_LABEL.linked}</span>
        ) : (
          <Badge variant="warning">{PAY_STATUS_LABEL[d.status]}</Badge>
        )}
      </TableCell>
      {pay && <TableCell className={num}>{money(d.pay)}</TableCell>}
      <TableCell className={num}>{money(d.charges)}</TableCell>
      <TableCell className={num}>
        <Figure v={d.contribution} />
      </TableCell>
    </>
  );
}

/** The clinic lines under the departments: branch overheads, L5, the allocated shared pools and L6. */
function ClinicLines({ l, pay, label }: { l: Level & ClinicLevels; pay: boolean; label: string }) {
  const span = pay ? 4 : 3;
  const line = (text: string, v: React.ReactNode, strong = false) => (
    <TableRow className={cn(strong && "font-semibold")}>
      <TableHead scope="row" className={cn(sticky, "text-foreground h-auto py-1.5 font-normal")}>
        {text}
      </TableHead>
      <TableCell colSpan={span} />
      <TableCell className={num}>{v}</TableCell>
    </TableRow>
  );
  return (
    <>
      {line(`Less branch overheads (${label})`, money(-l.branchOverhead))}
      {line("Clinic contribution (L5)", <Figure v={l.l5} withheld={l.withheld} />, true)}
      {line("Less shared overhead allocated", money(-l.allocated))}
      {line("After allocation (L6)", <Figure v={l.l6} withheld={l.withheld} />, true)}
    </>
  );
}

function ClinicTable({ c, pay }: { c: ClinicGroup; pay: boolean }) {
  return (
    <TableBody className="border-b-2">
      <TableRow className="bg-muted font-semibold">
        <TableHead scope="rowgroup" className={cn(sticky, "bg-muted text-foreground h-auto py-2")}>
          {c.label}
        </TableHead>
        <LevelCells l={c} pay={pay} />
      </TableRow>
      {c.departments.map((d) => (
        <DepartmentRows key={d.key} d={d} pay={pay} />
      ))}
      <ClinicLines l={c} pay={pay} label={c.label} />
    </TableBody>
  );
}

function DepartmentRows({ d, pay }: { d: ClinicGroup["departments"][number]; pay: boolean }) {
  return (
    <>
      <TableRow className="bg-muted/40 font-medium">
        <TableHead
          scope="row"
          className={cn(sticky, "bg-muted/40 text-foreground h-auto py-2 pl-4")}
        >
          {d.label}
        </TableHead>
        <LevelCells l={d} pay={pay} />
      </TableRow>
      {d.doctors.map((doc) => (
        <TableRow key={doc.key}>
          <TableHead
            scope="row"
            className={cn(sticky, "text-foreground h-auto py-2 pl-8 font-normal")}
          >
            {doc.name}
          </TableHead>
          <DoctorCells d={doc} pay={pay} />
        </TableRow>
      ))}
    </>
  );
}

export default async function ContributionPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.profit.view");
  const canSeePay = can(member, "finance.costs.compensation");
  const canLink = can(member, "finance.costs.manage");
  const sp = await searchParams;
  const thisMonth = `${todayIn(member.org.timezone).slice(0, 7)}-01`;

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadPerfScope(admin, member);
  const branch = chosenBranch(sp.branch, scope.allowed);
  const month =
    monthParam(sp.month) ??
    (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
    thisMonth;
  const r = await loadContribution(admin, member.orgId, {
    month,
    branch,
    allowed: scope.allowed,
    canSeePay,
    branchNames: Object.fromEntries(scope.branches.map((b) => [b.code, b.name])),
  });
  const refDoctors =
    canLink && r.unlinked.length > 0 ? await loadRefDoctors(admin, member.orgId) : [];
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });

  const title = monthTitle(month);
  const params = (m: string) =>
    new URLSearchParams({ month: m.slice(0, 7), ...(branch ? { branch } : {}) });
  const link = (m: string) => `/finance/contribution?${params(m)}`;
  const excel = `/api/finance/contribution?${params(month)}`;
  const t = r.total;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contribution"
        description="What each doctor, department and clinic contributes after the doctor pay and costs Finance has loaded, from the Unite collection report. Pay is never calculated here: only loaded amounts count. All amounts in AED."
      >
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

      {r.provisional && (
        <Alert>
          <AlertTitle>
            <Badge variant="warning">{PROVISIONAL_LABEL}</Badge> These figures are not final
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="mt-2">
              A month stops being provisional when Finance approves its costs and every doctor with
              revenue has pay loaded.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {!r.hasData ? (
        <Card>
          <CardHeader>
            <CardTitle>No Unite report data for {title} yet</CardTitle>
            <CardDescription>
              Revenue here comes from the Unite Daily Collection report, uploaded under Finance,
              Upload. Once a report covering {title} is committed, the figures appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <section
            aria-label="Headline figures"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiTile label={`Revenue, ${title} (AED)`} value={Math.round(t.revenue)} />
            <KpiTile
              label="Pay coverage"
              value={t.coverage === null ? null : Math.floor(t.coverage * 1000) / 1000}
              format="percent"
              hint="Share of revenue whose doctor has pay loaded"
            />
            <KpiTile
              label={`Clinic contribution, L5 (AED)${r.provisional ? `, ${PROVISIONAL_LABEL}` : ""}`}
              value={t.l5 === null ? null : Math.round(t.l5)}
              hint={t.withheld ? "Withheld: it would show an individual doctor's pay" : undefined}
            />
            <KpiTile
              label={`After allocation, L6 (AED)${r.provisional ? `, ${PROVISIONAL_LABEL}` : ""}`}
              value={t.l6 === null ? null : Math.round(t.l6)}
              hint={`Shared overhead allocated: ${money(t.allocated)}`}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                By clinic, department and doctor, {title}
                {r.provisional && (
                  <Badge variant="warning" className="ml-2 align-middle">
                    {PROVISIONAL_LABEL}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Doctor contribution (L3) = revenue − doctor pay Finance loaded − doctor charges
                (lab, referral, consumables, other). A department is the sum of its doctors
                (department cost pools are not loaded yet) and a clinic takes off its own branch
                overheads (L5), then the shared overheads allocated by their basis (L6). Pay,
                charges and contribution add up only the doctors whose pay is loaded; coverage is
                their share of revenue. A doctor whose pay is not linked or not loaded is never
                counted as zero pay.
                {!canSeePay &&
                  " Doctor pay needs the doctor compensation permission, so individual pay and each doctor's contribution are not shown, and a total that would show one doctor's pay is withheld."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <caption className="sr-only">
                  Contribution by clinic, department and doctor, {title}
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead className={sticky}>Clinic / department / doctor</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Pay coverage</TableHead>
                    {canSeePay && <TableHead className="text-right">Doctor pay</TableHead>}
                    <TableHead className="text-right">Charges</TableHead>
                    <TableHead className="text-right">Contribution</TableHead>
                  </TableRow>
                </TableHeader>
                {r.clinics.map((c) => (
                  <ClinicTable key={c.key} c={c} pay={canSeePay} />
                ))}
                {r.clinics.length > 1 && (
                  <TableBody>
                    <TableRow className="bg-muted font-semibold">
                      <TableHead
                        scope="rowgroup"
                        className={cn(sticky, "bg-muted text-foreground h-auto py-2")}
                      >
                        Total
                      </TableHead>
                      <LevelCells l={t} pay={canSeePay} />
                    </TableRow>
                    <ClinicLines l={t} pay={canSeePay} label="all clinics shown" />
                  </TableBody>
                )}
              </Table>
              <p className="text-muted-foreground mt-3 text-xs">
                Expected revenue after denials (L2) and department costs (L4) are not available yet.
                Covered dates: {r.dates.label}.
              </p>
            </CardContent>
          </Card>

          {canLink && (
            <Card id="doctor-links">
              <CardHeader>
                <CardTitle className="text-base">Link report doctors to DHA ids</CardTitle>
                <CardDescription>
                  The Unite report names doctors; pay and charges are loaded by DHA licence id. Link
                  each report doctor once and their loaded pay and charges count from then on, for
                  every month. Changes are recorded in the audit log.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {r.unlinked.length === 0 ? (
                  <p className="text-sm">Every doctor in this view is linked.</p>
                ) : refDoctors.length === 0 ? (
                  <p className="text-sm">
                    There are no doctors in the reference list yet, so nothing can be linked.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y">
                    {r.unlinked.map((u) => (
                      <li
                        key={u.doctorKey}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="text-sm">
                          {u.name}
                          <span className="text-muted-foreground block text-xs">
                            AED {money(u.revenue)} in {title}
                          </span>
                        </span>
                        <LinkDoctor doctorKey={u.doctorKey} name={u.name} doctors={refDoctors} />
                      </li>
                    ))}
                  </ul>
                )}
                {r.linked.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Linked doctors ({r.linked.length})
                    </summary>
                    <ul className="mt-2 flex flex-col divide-y">
                      {r.linked.map((l) => (
                        <li
                          key={l.doctorKey}
                          className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"
                        >
                          <span>
                            {l.name} <span className="text-muted-foreground">({l.dhaId})</span>
                          </span>
                          <UnlinkDoctor doctorKey={l.doctorKey} name={l.name} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
