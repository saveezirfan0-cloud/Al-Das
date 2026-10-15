import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthRange } from "@/lib/finance/close-server";
import { money } from "@/lib/finance/format";
import {
  SPECIAL_LABEL,
  STATUS_LABEL,
  UNUSUAL_LABEL,
  VOUCHER_READ_PERMS,
  voucherReport,
} from "@/lib/finance/vouchers";
import {
  loadPayablesSettings,
  loadReportRows,
  loadVoucherScope,
} from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Voucher report" };
export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function hours(h: number | null): string {
  if (h === null) return "-";
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

export default async function VoucherReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VOUCHER_READ_PERMS)) throw new ForbiddenError("finance.payables.view");
  const sp = await searchParams;
  const month = MONTH.test(sp.month ?? "") ? sp.month! : todayIn(member.org.timezone).slice(0, 7);
  const { first, last } = monthRange(month);
  const admin = createAdminClient(); // service role AFTER the permission check
  // only the vouchers this person may read (a department head: their Tier 2 queue and decisions)
  const scope = (await loadVoucherScope(admin, member)) ?? { special: false, ids: [] };
  const [rows, settings] = await Promise.all([
    loadReportRows(admin, member.orgId, first, last, scope),
    loadPayablesSettings(admin, member.orgId),
  ]);
  const r = voucherReport(rows, settings);
  const vhref = (id: string) => `/finance/vouchers?tab=approved&v=${id}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Voucher report"
        description="Status and exceptions for the vouchers dated in a month: what is pending at each stage, approved, paid and rejected, how long approval takes, special categories and unusual transactions."
      >
        <form className="flex items-center gap-2">
          <Input
            type="month"
            name="month"
            defaultValue={month}
            className="w-40"
            aria-label="Month"
          />
          <Button type="submit" variant="secondary" size="sm">
            Show
          </Button>
        </form>
        <Button asChild variant="outline">
          <Link href="/finance/vouchers">Vouchers</Link>
        </Button>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Approved, not paid", v: r.approved },
          { label: "Paid", v: r.paid },
          { label: "Rejected", v: r.rejected },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-sm">{k.label}</p>
              <p className="text-2xl font-semibold tabular-nums">{k.v.count}</p>
              <p className="text-muted-foreground text-xs tabular-nums">AED {money(k.v.amount)}</p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">Average approval time</p>
            <p className="text-2xl font-semibold tabular-nums">{hours(r.averageApprovalHours)}</p>
            <p className="text-muted-foreground text-xs">submission to final approval</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending by stage</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Vouchers</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.pending.map((p) => (
                <TableRow key={p.status}>
                  <TableCell>{STATUS_LABEL[p.status]}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By delegation tier</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Vouchers</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Average approval time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.byTier.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState title="No submitted vouchers this month" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                r.byTier.map((t) => (
                  <TableRow key={t.tier}>
                    <TableCell className="font-mono text-xs">{t.tier}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(t.amount)}</TableCell>
                    <TableCell className="text-right">{hours(t.averageApprovalHours)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exceptions: unusual transactions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">
            Possible duplicates within {settings.duplicateWindowDays} days, amounts that differ from
            their invoices by more than AED {money(settings.mismatchTolerance)}, AED{" "}
            {money(settings.largeAmount)} or more with no invoice, and special categories
            (thresholds under Voucher settings).
          </p>
          {r.unusual.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            r.unusual.map(({ row, flags }) => (
              <Link
                key={row.id}
                href={vhref(row.id)}
                className="rounded-md border p-2 text-sm hover:bg-accent/50"
              >
                <span className="font-mono text-xs">{row.voucherNo}</span> {row.payeeName}, AED{" "}
                {money(row.amount)}
                <span className="ml-2 inline-flex flex-wrap gap-1">
                  {flags.map((f) => (
                    <Badge key={f} variant={f === "special" ? "secondary" : "warning"}>
                      {UNUSUAL_LABEL[f]}
                    </Badge>
                  ))}
                </span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exceptions: rejected vouchers</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {r.rejectedRows.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            r.rejectedRows.map((row) => (
              <Link
                key={row.id}
                href={vhref(row.id)}
                className="rounded-md border p-2 text-sm hover:bg-accent/50"
              >
                <span className="font-mono text-xs">{row.voucherNo}</span> {row.payeeName}, AED{" "}
                {money(row.amount)} <Badge variant="outline">{STATUS_LABEL[row.status]}</Badge>
                {row.rejectionRemarks && (
                  <p className="text-muted-foreground mt-1">{row.rejectionRemarks}</p>
                )}
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Special categories</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {r.special.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            r.special.map((row) => (
              <Link
                key={row.id}
                href={vhref(row.id)}
                className="rounded-md border p-2 text-sm hover:bg-accent/50"
              >
                <span className="font-mono text-xs">{row.voucherNo}</span>{" "}
                {SPECIAL_LABEL[row.special]}: {row.payeeName}, AED {money(row.amount)}{" "}
                <Badge variant="outline">{STATUS_LABEL[row.status]}</Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
