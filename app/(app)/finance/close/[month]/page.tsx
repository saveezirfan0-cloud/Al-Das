import Link from "next/link";
import { notFound } from "next/navigation";

import { KpiCard } from "@/components/finance/kpi-card";
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
import { RecordHistorySection } from "@/components/history/record-history";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { METRIC_LABELS, monthLabel } from "@/lib/finance/close-pack";
import {
  lastClosedMonth,
  liveDriftFor,
  loadCloseByMonth,
  MONTH_RE,
} from "@/lib/finance/close-server";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { BuildButton, SignForm, WithdrawButton } from "../close-controls";
import { ControlsSummary } from "./controls-summary";

export const metadata = { title: "Month-end close" };
export const dynamic = "force-dynamic";

export default async function CloseMonthPage({ params }: { params: Promise<{ month: string }> }) {
  const member = await requireMember();
  if (
    !canAny(member, [
      "finance.close.view",
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.close.signoff.ceo",
    ])
  )
    throw new ForbiddenError("finance.close.view");
  const { month } = await params;
  if (!MONTH_RE.test(month)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check above
  const close = await loadCloseByMonth(admin, member.orgId, month);
  const ended = month <= lastClosedMonth(todayIn(member.org.timezone));
  const pack = close?.pack ?? null;
  const drift =
    pack && close && close.status !== "built" ? await liveDriftFor(admin, member.orgId, pack) : [];
  const isLocked = close?.status === "locked";
  const canManage = can(member, "finance.close.manage");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Month-end close: ${monthLabel(`${month}-01`)}`}
        description={
          pack
            ? `Pack built ${new Date(pack.built_at).toLocaleString("en-GB")}. These are the frozen figures; downloads are rendered from them, never from live data.`
            : "No pack has been built for this month yet."
        }
      >
        <Link href="/finance/close" className="text-sm underline-offset-2 hover:underline">
          All months
        </Link>
        {pack && (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/finance/close/${month}/pack?format=xlsx`}>Excel</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/finance/close/${month}/pack?format=pdf`}>PDF</a>
            </Button>
          </>
        )}
      </PageHeader>

      {isLocked && (
        <Alert>
          <AlertTitle>Locked</AlertTitle>
          <AlertDescription>
            Both sign-offs are in. The pack above, its fingerprint and this month&apos;s cash-ups
            can no longer be changed by anyone.
          </AlertDescription>
        </Alert>
      )}

      {!pack && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 text-sm">
            {ended ? (
              canManage ? (
                <>
                  <p>
                    Build the pack from the invoices, claims, payments, cash-ups and the control
                    summary (bank, payables, revenue share, invoice changes, timetable) Pulse holds
                    now. You can rebuild it until Finance signs.
                  </p>
                  <div>
                    <BuildButton month={month} rebuild={false} />
                  </div>
                </>
              ) : (
                <p>
                  The pack has not been built yet. Someone with the “Prepare the month-end close”
                  permission needs to build it.
                </p>
              )
            ) : (
              <p>This month has not ended yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {pack && close && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <KpiCard label="Invoiced (net)" value={pack.totals.generated} goodWhen="neutral" />
            <KpiCard label="Claimed" value={pack.totals.claimed} goodWhen="neutral" />
            <KpiCard label="Remitted" value={pack.totals.remitted} goodWhen="neutral" />
            <KpiCard label="Rejected" value={pack.totals.rejected} goodWhen="neutral" />
            <KpiCard
              label="Self-pay collected"
              value={pack.totals.self_pay_collected}
              goodWhen="neutral"
            />
            <KpiCard
              label="Collected, all payments"
              value={pack.totals.collected}
              goodWhen="neutral"
            />
            <KpiCard
              label="Outstanding (at build date)"
              value={pack.totals.outstanding}
              goodWhen="neutral"
            />
            <KpiCard
              label="Revenue (line net)"
              value={pack.totals.revenue_net}
              goodWhen="neutral"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sign-off</CardTitle>
              <CardDescription>
                Fingerprint of this pack:{" "}
                <span className="font-mono text-xs break-all">{close.hash}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={close.sign.financeAt ? "success" : "outline"}>
                  Finance:{" "}
                  {close.sign.financeAt
                    ? `${close.sign.financeBy ?? "signed"}, ${new Date(close.sign.financeAt).toLocaleDateString("en-GB")}`
                    : "waiting"}
                </Badge>
                <Badge variant={close.sign.ceoAt ? "success" : "outline"}>
                  CEO:{" "}
                  {close.sign.ceoAt
                    ? `${close.sign.ceoBy ?? "signed"}, ${new Date(close.sign.ceoAt).toLocaleDateString("en-GB")}`
                    : "waiting"}
                </Badge>
              </div>
              {close.sign.financeNote && (
                <p className="text-muted-foreground text-xs">
                  Finance note: {close.sign.financeNote}
                </p>
              )}
              {close.sign.ceoNote && (
                <p className="text-muted-foreground text-xs">CEO note: {close.sign.ceoNote}</p>
              )}
              {close.status === "built" && canManage && (
                <div>
                  <BuildButton month={month} rebuild />
                </div>
              )}
              {close.status === "built" &&
                can(member, "finance.close.signoff.finance") &&
                close.hash && (
                  <SignForm who="finance" id={close.id} month={month} hash={close.hash} />
                )}
              {close.status === "built" && !can(member, "finance.close.signoff.finance") && (
                <p className="text-muted-foreground">
                  Waiting for someone with the finance sign-off permission.
                </p>
              )}
              {close.status === "finance_signed" &&
                can(member, "finance.close.signoff.ceo") &&
                close.hash &&
                (close.financeById === member.userId ? (
                  <p className="text-muted-foreground">
                    You signed for Finance, so a different person must sign as CEO.
                  </p>
                ) : (
                  <SignForm who="ceo" id={close.id} month={month} hash={close.hash} />
                ))}
              {close.status === "finance_signed" && !can(member, "finance.close.signoff.ceo") && (
                <p className="text-muted-foreground">Waiting for the CEO.</p>
              )}
              {close.status === "finance_signed" && canManage && (
                <div>
                  <WithdrawButton id={close.id} month={month} />
                </div>
              )}
            </CardContent>
          </Card>

          {drift.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>The live figures differ from this pack</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <p>
                  Unite or Diligence sent changes after the pack was built. The pack does not
                  change; this is what is different now.
                </p>
                <ul className="list-disc pl-5 text-xs">
                  {drift.map((d) => (
                    <li key={d.metric}>
                      {METRIC_LABELS[d.metric] ?? d.metric}: pack {money(d.frozen)}, now{" "}
                      {money(d.live)} (difference {money(d.difference)})
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <ControlsSummary pack={pack} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By branch</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Branch</TableHead>
                      <TableHead className="text-right">Invoiced</TableHead>
                      <TableHead className="text-right">Claimed</TableHead>
                      <TableHead className="text-right">Remitted</TableHead>
                      <TableHead className="text-right">Self-pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pack.by_branch.map((b) => (
                      <TableRow key={b.branch}>
                        <TableCell className="text-xs">{b.branch}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(b.generated)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(b.claimed)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(b.remitted)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(b.self_pay_collected)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Collections by payment mode</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mode</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Refunds</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pack.collections.map((c) => (
                      <TableRow key={c.mode}>
                        <TableCell className="text-xs">{c.mode}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(c.paid)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(c.refunds)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Revenue by category</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {pack.revenue.by_category.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="text-xs">{r.label ?? r.key}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(r.net)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Receivables ageing (at build date)</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {pack.ageing.map((a) => (
                      <TableRow key={a.bucket}>
                        <TableCell className="text-xs">{a.bucket} days</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {a.claims}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(a.outstanding)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
          <p className="text-muted-foreground text-xs">
            {pack.notes.join(" ")} Excel and PDF carry the full tables (departments, doctors, denial
            reasons, remittance and cash-up).
          </p>
          <RecordHistorySection table="fin_period_closes" recordId={close.id} />
        </>
      )}
    </div>
  );
}
