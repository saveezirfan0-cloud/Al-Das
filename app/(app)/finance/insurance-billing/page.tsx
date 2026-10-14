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
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { money } from "@/lib/finance/format";
import { UNREPORTED_NOTE, type BilledInvoice } from "@/lib/finance/insurance-billing";
import { loadInsuranceBilling } from "@/lib/finance/insurance-billing-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Insurance billed vs claimed" };
export const dynamic = "force-dynamic";

type Search = { month?: string; branch?: string };

/** Lists longer than this show their first rows; the Excel download has every row. */
const LIMIT = 200;
const num = "text-right tabular-nums whitespace-nowrap";
const int = (v: number) => v.toLocaleString("en-GB");

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

function Who({ inv, names }: { inv: BilledInvoice; names: Map<string, string> }) {
  return (
    <>
      {inv.visiblePairs.map((p, i) => (
        <span key={i} className="block">
          {p.branch ? (names.get(p.branch) ?? p.branch) : "Unknown branch"}: {p.doctor}
        </span>
      ))}
    </>
  );
}

function More({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="text-muted-foreground mt-2 text-xs">
      Showing {int(shown)} of {int(total)}. Download Excel for every row.
    </p>
  );
}

export default async function InsuranceBillingPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const thisMonth = `${today.slice(0, 7)}-01`;

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadPerfScope(admin, member);
  const branch = chosenBranch(sp.branch, scope.allowed);
  const month =
    monthParam(sp.month) ??
    (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
    thisMonth;
  const r = await loadInsuranceBilling(admin, member.orgId, {
    month,
    branch,
    allowed: scope.allowed,
    asOf: today,
  });
  await recordAccess(admin, member, { entity: "finance_claim", action: "list" });

  const names = new Map(scope.branches.map((b) => [b.code, b.name]));
  const title = monthTitle(month);
  const s = r.summary;
  const tol = money(r.settings.tolerance);
  const query = (m: string) =>
    new URLSearchParams({ month: m.slice(0, 7), ...(branch ? { branch } : {}) }).toString();
  const link = (m: string) => `/finance/insurance-billing?${query(m)}`;
  const excel = `/api/finance/insurance-billing?${query(month)}`;
  const flagged = r.matched.filter((m) => m.flagged);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Insurance billed vs claimed"
        description="What the Unite collection report billed to insurers against what Diligence shows was submitted, by invoice number, for one month. Review signals for the insurance team, not proof."
      >
        {can(member, "finance.targets.manage") && (
          <Button asChild variant="outline">
            <Link href="/finance/flash/settings#insurance-billing">Tolerance and grace days</Link>
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
            <CardTitle>Nothing billed to insurers in {title} yet</CardTitle>
            <CardDescription>
              Billed amounts come from the Unite collection report and submissions from the
              Diligence claim file, both uploaded under{" "}
              {can(member, "finance.claims.import") || can(member, "finance.revenue.import") ? (
                <Link className="text-primary underline" href="/finance/upload">
                  Finance, Uploads
                </Link>
              ) : (
                "Finance, Uploads"
              )}
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {!r.coverage.full && (
            <Alert>
              <AlertTitle>Part of the month is missing</AlertTitle>
              <AlertDescription>
                {title} is only partly covered by Unite report uploads ({r.coverage.label}).
                Invoices on the missing days are not listed.
              </AlertDescription>
            </Alert>
          )}

          <section
            aria-label="Headline figures"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiTile
              label={`Billed to insurers, ${title} (AED)`}
              value={s.billed}
              hint={`${int(s.billedRows)} report rows`}
            />
            <KpiTile
              label="Submitted on these invoices (AED)"
              value={s.submitted}
              hint={`${int(s.matchedCount)} invoice numbers found in Diligence`}
            />
            <KpiTile
              label="Matched (share of billed AED)"
              value={s.matchedPct}
              format="percent"
              hint={`${int(s.flaggedCount)} with a difference over AED ${tol}`}
            />
            <KpiTile
              label="At risk: billed, not submitted (AED)"
              value={s.atRisk}
              hint={`${int(s.atRiskCount)} invoices past ${r.settings.graceDays} days; ${int(s.awaitingCount)} still inside`}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billed, not submitted</CardTitle>
              <CardDescription>
                Billed to an insurer in the Unite report, no claim activity in Diligence, and more
                than {r.settings.graceDays} days since the report date (as of {today}). Oldest
                first.
                {s.awaitingCount > 0 &&
                  ` A further ${int(s.awaitingCount)} (AED ${money(s.awaitingAmount)}) are still inside the grace days.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {r.billedNotSubmitted.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing at risk.</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice number</TableHead>
                        <TableHead>Report date</TableHead>
                        <TableHead className="text-right">Days</TableHead>
                        <TableHead className="text-right">Billed (AED)</TableHead>
                        <TableHead>Branch: doctor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.billedNotSubmitted.slice(0, LIMIT).map((x) => (
                        <TableRow key={x.key}>
                          <TableCell className="font-mono text-xs">{x.invoiceNo}</TableCell>
                          <TableCell className="whitespace-nowrap">{x.lastDate}</TableCell>
                          <TableCell className={num}>{x.ageDays}</TableCell>
                          <TableCell className={num}>{money(x.billed)}</TableCell>
                          <TableCell className="text-xs">
                            <Who inv={x} names={names} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <More shown={LIMIT} total={r.billedNotSubmitted.length} />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billed and submitted amounts differ</CardTitle>
              <CardDescription>
                Invoice numbers Diligence has, where billed − submitted is more than AED {tol}{" "}
                either way. {int(r.matched.length - flagged.length)} more agree within the tolerance
                (in the Excel download).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {flagged.length === 0 ? (
                <p className="text-muted-foreground text-sm">No differences over the tolerance.</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice number</TableHead>
                        <TableHead>Report date</TableHead>
                        <TableHead className="text-right">Billed</TableHead>
                        <TableHead className="text-right">Submitted</TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                        <TableHead>Payer</TableHead>
                        <TableHead>Branch: doctor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {flagged.slice(0, LIMIT).map((x) => (
                        <TableRow key={x.key}>
                          <TableCell className="font-mono text-xs">{x.invoiceNo}</TableCell>
                          <TableCell className="whitespace-nowrap">{x.lastDate}</TableCell>
                          <TableCell className={num}>{money(x.billed)}</TableCell>
                          <TableCell className={num}>{money(x.submitted)}</TableCell>
                          <TableCell className={cn(num, "text-destructive")}>
                            {money(x.difference)}
                          </TableCell>
                          <TableCell className="text-xs">{x.payers.join(", ") || "—"}</TableCell>
                          <TableCell className="text-xs">
                            <Who inv={x} names={names} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <More shown={LIMIT} total={flagged.length} />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Submitted, not in this month&apos;s report
              </CardTitle>
              <CardDescription>
                Diligence activities dated in {title} whose invoice number is on no row of this
                month&apos;s Unite report. Check the month: they may belong to another month, or the
                invoice was cancelled in Unite.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!r.unreportedShown ? (
                <p className="text-muted-foreground text-sm">
                  Diligence activities carry no branch, so this list is shown only to members who
                  see every branch, with no branch chosen.
                </p>
              ) : r.unreported.length === 0 ? (
                <p className="text-muted-foreground text-sm">None.</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice number</TableHead>
                        <TableHead>Activity date</TableHead>
                        <TableHead className="text-right">Submitted (AED)</TableHead>
                        <TableHead>Payer</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.unreported.slice(0, LIMIT).map((x) => (
                        <TableRow key={x.key}>
                          <TableCell className="font-mono text-xs">{x.invoiceNo}</TableCell>
                          <TableCell className="whitespace-nowrap">{x.firstDate ?? "—"}</TableCell>
                          <TableCell className={num}>{money(x.submitted)}</TableCell>
                          <TableCell className="text-xs">{x.payers.join(", ") || "—"}</TableCell>
                          <TableCell>
                            <Badge variant="warning">
                              {x.note === "other_month" && x.reportMonth
                                ? `Check the month: in the ${monthTitle(x.reportMonth)} report`
                                : UNREPORTED_NOTE[x.note]}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <More shown={LIMIT} total={r.unreported.length} />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ambiguous invoice numbers</CardTitle>
              <CardDescription>
                The report gives these numbers more than one branch or doctor this month, so they
                are never paired automatically. Check them in Unite.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {r.ambiguous.length === 0 ? (
                <p className="text-muted-foreground text-sm">None.</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice number</TableHead>
                        <TableHead className="text-right">Billed</TableHead>
                        <TableHead className="text-right">Submitted</TableHead>
                        <TableHead className="text-right">Branch/doctor pairs</TableHead>
                        <TableHead>Yours</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.ambiguous.slice(0, LIMIT).map((x) => (
                        <TableRow key={x.key}>
                          <TableCell className="font-mono text-xs">{x.invoiceNo}</TableCell>
                          <TableCell className={num}>{money(x.billed)}</TableCell>
                          <TableCell className={num}>{money(x.submitted)}</TableCell>
                          <TableCell className={num}>{x.pairs}</TableCell>
                          <TableCell className="text-xs">
                            <Who inv={x} names={names} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <More shown={LIMIT} total={r.ambiguous.length} />
                </>
              )}
            </CardContent>
          </Card>

          <footer className="text-muted-foreground flex flex-col gap-1 text-xs">
            <span>
              Invoice numbers are compared in upper case with spaces removed. Billed is the Unite
              report&apos;s Insurance Claim; submitted is the Diligence net as of the latest upload.
            </span>
            {s.noInvoiceNoRows > 0 && (
              <span>
                {int(s.noInvoiceNoRows)} billed rows (AED {money(s.noInvoiceNoAmount)}) have no
                insurance invoice number and cannot be paired.
              </span>
            )}
            {s.cancelledRows > 0 && (
              <span>
                {int(s.cancelledRows)} cancelled rows with an insurance claim (AED{" "}
                {money(s.cancelledAmount)}) are left out.
              </span>
            )}
            {r.unreportedShown && s.submittedNoInvoiceNoActivities > 0 && (
              <span>
                {int(s.submittedNoInvoiceNoActivities)} Diligence activities this month (AED{" "}
                {money(s.submittedNoInvoiceNoAmount)}) have no invoice number.
              </span>
            )}
            <span>Covered dates: {r.coverage.label}.</span>
          </footer>
        </>
      )}
    </div>
  );
}
