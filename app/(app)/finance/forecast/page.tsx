import { HorizontalBars } from "@/components/finance/bars";
import { KpiCard } from "@/components/finance/kpi-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { buildForecast, parseHistory, parseOutstanding } from "@/lib/finance/forecast";
import { money } from "@/lib/finance/format";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Collections forecast" };
export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  const member = await requirePerm("finance.forecast.view");
  const admin = createAdminClient(); // service role AFTER the permission check; every function takes the org explicitly
  const settings = await loadFinanceSettings(admin, member.orgId);
  const today = todayIn(member.org.timezone);
  const [{ data: out }, { data: hist }] = await Promise.all([
    admin.rpc("fin_forecast_outstanding", { p_org_id: member.orgId }),
    admin.rpc("fin_forecast_history", { p_org_id: member.orgId }),
  ]);
  const forecast = buildForecast(parseOutstanding(out), parseHistory(hist), today, {
    horizonWeeks: settings.forecastHorizonWeeks,
    defaultLagDays: settings.forecastDefaultLagDays,
    defaultCollectionRate: settings.forecastDefaultCollectionRate,
    minHistory: settings.forecastMinHistory,
    tailWeeks: settings.forecastTailWeeks,
  });
  const assumed = forecast.payers.filter((p) => p.assumed);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Collections forecast"
        description={`Expected insurance cash by week for the next ${settings.forecastHorizonWeeks} weeks, from what is still owed and how each payer has paid before. An estimate, not a promise.`}
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          label="Still owed (insurance)"
          value={forecast.totalOutstanding}
          goodWhen="neutral"
        />
        <KpiCard
          label={`Expected in ${settings.forecastHorizonWeeks} weeks`}
          value={forecast.expectedTotal - forecast.beyondHorizon}
          goodWhen="neutral"
        />
        <KpiCard label="Expected later" value={forecast.beyondHorizon} goodWhen="neutral" />
        <KpiCard
          label="Not expected to be collected"
          value={forecast.notExpected}
          goodWhen="neutral"
          note="Owed less the payers' usual collection rate"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>By week</CardTitle>
          <CardDescription>
            Weeks start on Monday. Cumulative total beside each bar in the table.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {forecast.totalOutstanding === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing is outstanding, or no Diligence file has been imported yet.
            </p>
          ) : (
            <>
              <HorizontalBars
                rows={forecast.weekStarts.map((w, i) => ({ label: w, value: forecast.weeks[i] }))}
              />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Week of</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Cumulative</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecast.weekStarts.map((w, i) => (
                    <TableRow key={w}>
                      <TableCell className="text-xs">{w}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(forecast.weeks[i])}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(forecast.cumulative[i])}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By payer</CardTitle>
          <CardDescription>
            {assumed.length > 0
              ? `${assumed.length} payer(s) have fewer than ${settings.forecastMinHistory} paid claims, so the defaults apply (marked “assumed”): ${settings.forecastDefaultLagDays} days to pay, ${Math.round(settings.forecastDefaultCollectionRate * 100)}% collected.`
              : "Every payer has enough history."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payer</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="text-right">Collection rate</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {forecast.payers.map((p) => (
                <TableRow key={p.payerId}>
                  <TableCell className="text-xs">{p.payerId}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(p.outstanding)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {(p.collectionRate * 100).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(p.expected)}
                  </TableCell>
                  <TableCell>{p.assumed && <Badge variant="outline">assumed</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-xs">
        Method: each payer&apos;s past days-to-pay (25th, 50th, 75th and 90th percentile) cuts the
        wait into slices; a claim that is already {"n"} days old can only be paid in the slices that
        have not passed; the money is placed in the middle of each slice and multiplied by the
        payer&apos;s collection rate on claims old enough to have been paid. Self-pay balances are
        not included. The thresholds are in Workflow settings.
      </p>
    </div>
  );
}
