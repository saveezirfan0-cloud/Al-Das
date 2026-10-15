import Link from "next/link";

import { KpiTile } from "@/components/charts/kpi-tile";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { SUM_COLUMNS, UNKNOWN_BRANCH_LABEL, type Sums } from "@/lib/finance/collections";
import { loadCollections } from "@/lib/finance/collections-server";
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Collections and data quality" };
export const dynamic = "force-dynamic";

type Search = { month?: string; branch?: string };

const num = "text-right tabular-nums whitespace-nowrap";
const int = (v: number) => v.toLocaleString("en-GB");
const sticky = "bg-card sticky left-0 z-10 min-w-32 max-w-64";

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** One table of the full sums: a label column, Rows, then every payment and share column. */
function SumsTable({
  caption,
  first,
  rows,
  total,
}: {
  caption: string;
  first: string;
  rows: { key: string; label: React.ReactNode; sums: Sums }[];
  total?: Sums;
}) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead className={sticky}>{first}</TableHead>
          <TableHead className="text-right">Rows</TableHead>
          {SUM_COLUMNS.map(([k, label]) => (
            <TableHead key={k} className="text-right whitespace-nowrap">
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableHead
              scope="row"
              className={cn(sticky, "text-foreground h-auto py-2 font-normal")}
            >
              {r.label}
            </TableHead>
            <TableCell className={num}>{int(r.sums.rows)}</TableCell>
            {SUM_COLUMNS.map(([k]) => (
              <TableCell key={k} className={cn(num, k === "collected" && "font-medium")}>
                {money(r.sums[k])}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {total && (
          <TableRow className="bg-muted/50 font-semibold">
            <TableHead scope="row" className={cn(sticky, "bg-muted text-foreground h-auto py-2")}>
              Total
            </TableHead>
            <TableCell className={num}>{int(total.rows)}</TableCell>
            {SUM_COLUMNS.map(([k]) => (
              <TableCell key={k} className={num}>
                {money(total[k])}
              </TableCell>
            ))}
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<Search> }) {
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
  const r = await loadCollections(admin, member.orgId, { month, branch, allowed: scope.allowed });
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });

  const title = monthTitle(month);
  const names = Object.fromEntries(scope.branches.map((b) => [b.code, b.name]));
  const link = (m: string) =>
    `/finance/collections?${new URLSearchParams({ month: m.slice(0, 7), ...(branch ? { branch } : {}) })}`;
  const excel = `/api/finance/collections?${new URLSearchParams({ month: month.slice(0, 7), ...(branch ? { branch } : {}) })}`;
  const t = r.total;
  const rec = r.reconciliation;
  const flagged = r.signals.filter((s) => s.rows > 0).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Collections and data quality"
        description="Payment modes, patient share and insurance claims by day, branch, doctor and invoice type, with data-quality signals, from the Unite collection report."
      >
        {can(member, "finance.targets.manage") && (
          <Button asChild variant="outline">
            <Link href="/finance/flash/settings#data-quality">Late invoice setting</Link>
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
          {!r.coverageInfo.full && (
            <Alert>
              <AlertTitle>Part of the month is missing</AlertTitle>
              <AlertDescription>
                {title} is only partly covered ({r.coverageInfo.label}). Totals cover those dates
                only.
              </AlertDescription>
            </Alert>
          )}

          <section
            aria-label="Headline figures"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiTile
              label={`Collected, ${title} (AED)`}
              value={Math.round(t.collected)}
              hint="Cash, card, bank transfer, gateway and other"
            />
            <KpiTile
              label="Net billing (AED)"
              value={Math.round(t.net)}
              hint={`${int(t.rows)} report rows`}
            />
            <KpiTile
              label="Insurance claim (AED)"
              value={Math.round(t.insuranceClaim)}
              hint={`Patient share AED ${money(t.patientShare)}`}
            />
            <KpiTile
              label="Data-quality signals"
              value={flagged}
              hint={flagged === 0 ? "Nothing to review" : "Signals with rows to review"}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By day, {title}</CardTitle>
              <CardDescription>
                By report date (invoice date, else visit date). Total collected is cash + card +
                bank transfer + payment gateway + other payment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SumsTable
                caption={`Collections by day, ${title}`}
                first="Date"
                rows={r.days.map((d) => ({ key: d.date, label: dayLabel(d.date), sums: d }))}
                total={t}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By branch</CardTitle>
              <CardDescription>
                Branch from the Unite clinic and the current branch mapping. Rows whose clinic is
                not mapped show as unknown (only to people who see every branch).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SumsTable
                caption={`Collections by branch, ${title}`}
                first="Branch"
                rows={r.branches.map((b) => ({
                  key: b.branchCode ?? "-",
                  label:
                    b.branchCode === null
                      ? UNKNOWN_BRANCH_LABEL
                      : (names[b.branchCode] ?? b.branchCode),
                  sums: b,
                }))}
                total={t}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Self-pay and insurance</CardTitle>
              <CardDescription>
                By Unite&apos;s invoice type. A blank or unrecognised type is its own line, never
                guessed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SumsTable
                caption={`Collections by invoice type, ${title}`}
                first="Invoice type"
                rows={r.buckets.map((b) => ({
                  key: b.bucket,
                  label: (
                    <>
                      {b.label}
                      {b.bucket === "other" && (
                        <span className="text-muted-foreground block text-xs">
                          {b.types.join("; ")}
                        </span>
                      )}
                    </>
                  ),
                  sums: b,
                }))}
                total={t}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By doctor</CardTitle>
              <CardDescription>Ordered by net billing.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <caption className="sr-only">Collections by doctor, {title}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead className={sticky}>Doctor</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Net billing</TableHead>
                    <TableHead className="text-right">Total collected</TableHead>
                    <TableHead className="text-right">Insurance claim</TableHead>
                    <TableHead className="text-right">Outstanding credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.doctors.map((d) => (
                    <TableRow key={d.doctorKey}>
                      <TableHead
                        scope="row"
                        className={cn(sticky, "text-foreground h-auto py-2 font-normal")}
                      >
                        {d.name}
                      </TableHead>
                      <TableCell className={num}>{int(d.rows)}</TableCell>
                      <TableCell className={num}>{money(d.net)}</TableCell>
                      <TableCell className={num}>{money(d.collected)}</TableCell>
                      <TableCell className={num}>{money(d.insuranceClaim)}</TableCell>
                      <TableCell className={num}>{money(d.outstandingCredit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reconciliation, {title}</CardTitle>
              <CardDescription>
                Net billing against what Unite says paid for it. Unite&apos;s columns are not
                guaranteed to add up (VAT, consumption and credit are on different bases), so the
                difference is shown for review, not assumed to be 0.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-1 text-sm sm:max-w-xl sm:grid-cols-[1fr_auto]">
                <dt>Net billing</dt>
                <dd className={num}>AED {money(rec.net)}</dd>
                <dt>
                  Collected + insurance claim + patient share + outstanding credit + advance
                  consumed + credit note consumed
                </dt>
                <dd className={num}>AED {money(rec.accountedFor)}</dd>
                <dt className="font-semibold">Difference</dt>
                <dd className={cn(num, "font-semibold")}>AED {money(rec.difference)}</dd>
              </dl>
            </CardContent>
          </Card>

          <Card id="data-quality">
            <CardHeader>
              <CardTitle className="text-base">Data quality</CardTitle>
              <CardDescription>
                Review signals, never proof. A row can appear in more than one signal; AED is the
                rows&apos; net billing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {r.signals.map((s) => (
                  <li key={s.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
                    <div className="flex-1">
                      <div className="font-medium">{s.title}</div>
                      <p className="text-muted-foreground text-sm">{s.sentence}</p>
                      {s.rows > 0 && <p className="text-sm">What to do: {s.action}</p>}
                      {s.key === "unknown_branch" && r.unknownClinics.length > 0 && (
                        <ul className="text-muted-foreground mt-1 list-disc pl-5 text-sm">
                          {r.unknownClinics.map((c) => (
                            <li key={c.clinic ?? "-"}>
                              {c.clinic ?? "(blank clinic)"}: {int(c.rows)} rows, AED {money(c.net)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex gap-6 sm:flex-col sm:items-end sm:gap-0">
                      <span className={cn("tabular-nums", s.rows > 0 && "font-semibold")}>
                        {int(s.rows)} {s.rows === 1 ? "row" : "rows"}
                      </span>
                      <span className="text-muted-foreground text-sm tabular-nums">
                        AED {money(s.net)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <footer className="text-muted-foreground text-xs">
            Covered dates: {r.coverageInfo.label}.
          </footer>
        </>
      )}
    </div>
  );
}
