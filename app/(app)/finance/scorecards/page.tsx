import Link from "next/link";

import { HorizontalBars } from "@/components/finance/bars";
import { PageHeader } from "@/components/shell/page-header";
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
import { requirePerm } from "@/lib/auth/session";
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import {
  parseScorecardRows,
  pct,
  scorecardMetrics,
  sortScorecard,
  SORTS,
  type Rag,
  type ScorecardSort,
} from "@/lib/finance/scorecard";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Payer scorecards" };
export const dynamic = "force-dynamic";

const GROUPS = [
  ["payer", "Payer"],
  ["doctor", "Doctor"],
  ["department", "Department"],
  ["branch", "Branch"],
] as const;
type Group = (typeof GROUPS)[number][0];
type Search = { from?: string; to?: string; group?: string; payer?: string; sort?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RAG_VARIANT: Record<Rag, "success" | "warning" | "destructive" | "secondary"> = {
  green: "success",
  amber: "warning",
  red: "destructive",
  grey: "secondary",
};

export default async function ScorecardsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.scorecards.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const to = DATE.test(sp.to ?? "") ? sp.to! : today;
  const from = DATE.test(sp.from ?? "") ? sp.from! : (addDays(to, -90) ?? to);
  const group: Group = GROUPS.some(([k]) => k === sp.group) ? (sp.group as Group) : "payer";
  const sort: ScorecardSort = (SORTS as readonly string[]).includes(sp.sort ?? "")
    ? (sp.sort as ScorecardSort)
    : "claims";
  const payer = (sp.payer ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || null;

  // read through the service role AFTER the permission check above; every function takes the org explicitly
  const admin = createAdminClient();
  const settings = await loadFinanceSettings(admin, member.orgId);
  const [{ data: rowsJson }, { data: reasons }] = await Promise.all([
    admin.rpc("fin_payer_scorecard", {
      p_org_id: member.orgId,
      p_from: from,
      p_to: to,
      p_group: group,
      p_payer: payer ?? undefined,
    }),
    admin.rpc("fin_denial_reasons", {
      p_org_id: member.orgId,
      p_from: from,
      p_to: to,
      p_payer: payer ?? undefined,
      p_limit: 10,
    }),
  ]);
  const th = {
    minClaims: settings.scorecardMinClaims,
    denialRateWarn: settings.scorecardDenialRateWarn,
    denialRateAlert: settings.scorecardDenialRateAlert,
    daysToPayWarn: settings.scorecardDaysToPayWarn,
    daysToPayAlert: settings.scorecardDaysToPayAlert,
  };
  const rows = sortScorecard(
    parseScorecardRows(rowsJson).map((r) => scorecardMetrics(r, th)),
    sort,
  );
  const reasonRows = (Array.isArray(reasons) ? reasons : []) as unknown as Array<{
    reason_code: string;
    description: string | null;
    claims: number;
    amount: number;
  }>;
  const totalClaims = rows.reduce((a, r) => a + r.claims, 0);
  const totalDenied = rows.reduce((a, r) => a + r.denied_claims, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payer scorecards"
        description="How each payer, doctor, department and branch performs on denials and on time to pay, for claims dated in the period. Colours need at least a minimum number of claims to mean anything."
      />
      <form className="grid gap-2 sm:grid-cols-6">
        <Input name="from" type="date" defaultValue={from} aria-label="From" />
        <Input name="to" type="date" defaultValue={to} aria-label="To" />
        <select
          name="group"
          defaultValue={group}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          {GROUPS.map(([k, l]) => (
            <option key={k} value={k}>
              By {l.toLowerCase()}
            </option>
          ))}
        </select>
        <Input name="payer" placeholder="Only payer ID" defaultValue={payer ?? ""} />
        <select
          name="sort"
          defaultValue={sort}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="claims">Most claims</option>
          <option value="denial_rate">Highest denial rate</option>
          <option value="days_to_pay">Slowest to pay</option>
          <option value="rejected">Most rejected</option>
        </select>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      <p className="text-muted-foreground text-sm">
        {totalClaims.toLocaleString()} claim activities, {totalDenied.toLocaleString()} denied (
        {pct(totalClaims ? totalDenied / totalClaims : null)}). A claim counts as denied if any
        amount was rejected at first adjudication or still is. Days to pay runs from the claim date
        to the first remittance. Thresholds: denial rate amber from {pct(th.denialRateWarn, 0)}, red
        from {pct(th.denialRateAlert, 0)}; days to pay amber from {th.daysToPayWarn}, red from{" "}
        {th.daysToPayAlert}; judged with at least {th.minClaims} claims (change them in Workflow
        settings).
      </p>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No claims in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUPS.find(([k]) => k === group)![1]}</TableHead>
                  <TableHead className="text-right">Claims</TableHead>
                  <TableHead className="text-right">Denied</TableHead>
                  <TableHead className="text-right">Denial rate</TableHead>
                  <TableHead className="text-right">Claimed</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Days to pay (avg / 90th)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.group_key}>
                    <TableCell className="text-xs">
                      {group === "payer" ? (
                        <Link
                          className="underline-offset-2 hover:underline"
                          href={`/finance/scorecards?${new URLSearchParams({ from, to, group: "doctor", payer: r.group_key }).toString()}`}
                          title="See this payer by doctor"
                        >
                          {r.group_label ?? r.group_key}
                        </Link>
                      ) : (
                        (r.group_label ?? r.group_key)
                      )}
                      {r.group_label && (
                        <span className="text-muted-foreground ml-1 font-mono">{r.group_key}</span>
                      )}
                      {r.lowSample && (
                        <span className="text-muted-foreground ml-2">few claims</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.claims}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.denied_claims}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={RAG_VARIANT[r.denialRag]}>{pct(r.denialRate)}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(r.net)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(r.rejected)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {pct(r.collectionRate)}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <Badge variant={RAG_VARIANT[r.daysRag]}>
                        {r.avg_days_to_pay === null ? "n/a" : `${r.avg_days_to_pay}`}
                      </Badge>{" "}
                      <span className="text-muted-foreground tabular-nums">
                        / {r.p90_days_to_pay ?? "n/a"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Top denial reasons</CardTitle>
          <CardDescription>
            Ranked by rejected amount{payer ? ` for ${payer}` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reasonRows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No denials in this period.</p>
          ) : (
            <HorizontalBars
              tone="danger"
              rows={reasonRows.map((r) => ({
                label: r.reason_code,
                value: Number(r.amount),
                note: `${r.claims} claim(s)${r.description ? `. ${r.description}` : ""}`,
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
