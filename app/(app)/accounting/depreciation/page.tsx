import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { peopleNames } from "@/lib/accounting/accounting-server";
import { addMonths } from "@/lib/accounting/assets/depreciation";
import {
  loadAssetReport,
  loadAssets,
  loadRunLines,
  loadRuns,
} from "@/lib/accounting/assets/server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { PrepareRunForm } from "./controls";
import { RunsTable } from "./runs-table";

export const metadata = { title: "Depreciation" };
export const dynamic = "force-dynamic";

const VIEW = [
  "accounting.assets.manage",
  "accounting.journals.approve",
  "accounting.reports.view",
  "accounting.view",
];

export default async function DepreciationPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW)) throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.assets.manage");
  const approve = can(member, "accounting.journals.approve");
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const [runs, report, assets] = await Promise.all([
    loadRuns(admin, member.orgId, ["depreciation"]),
    loadAssetReport(admin, member.orgId, today, today),
    loadAssets(admin, member.orgId),
  ]);
  const runParam = (await searchParams).run ?? null;
  const selected = runs.find((r) => r.id === runParam) ?? null;
  const lines = selected
    ? await loadRunLines(admin, member.orgId, selected.id, selected.version)
    : [];
  const people = await peopleNames(
    admin,
    runs.flatMap((r) => [r.preparedBy, r.postedBy]),
  );
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const lastMonth = addMonths(today, -1).slice(0, 7);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Depreciation"
        description="One run per month. Prepare a month to see each asset's charge (it catches up anything not posted before); someone else with journal approval posts it as one journal: depreciation expense against accumulated depreciation, by class and branch. A changed month is prepared again as a new version, and posting it reverses the old journal."
      />
      {manage && (
        <Card>
          <CardContent className="pt-6">
            <PrepareRunForm
              kind="depreciation"
              defaultMonth={lastMonth}
              label="Prepare depreciation"
            />
            <p className="text-muted-foreground mt-2 text-xs">
              Pulse prepares last month&apos;s run itself on the first working day of each month and
              tells the people who manage assets. Only the latest month can be run again once a
              later month is posted.
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runs</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <RunsTable
            runs={runs}
            people={people}
            viewerId={member.userId}
            canPost={approve}
            basePath="/accounting/depreciation"
            selected={selected?.id ?? null}
          />
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Lines for {selected.periodMonth.slice(0, 7)} (version {selected.version})
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Depreciation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground text-sm">
                      Nothing to charge this month.
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => {
                  const a = l.asset_id ? assetById.get(l.asset_id) : undefined;
                  return (
                    <TableRow key={l.id}>
                      <TableCell>
                        <span className="font-mono text-xs">{a?.code}</span> {a?.description}
                      </TableCell>
                      <TableCell>{a?.className}</TableCell>
                      <TableCell>{l.branch_code ?? ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Forecast, next 12 months</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="text-muted-foreground mb-2 text-xs">
            From {report.forecastFrom.slice(0, 7)} for the assets in service today; the first month
            includes anything not posted yet. New assets and disposals change it.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                {report.forecast.map((f) => (
                  <TableHead key={f.month} className="text-right">
                    {f.month.slice(0, 7)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                {report.forecast.map((f) => (
                  <TableCell key={f.month} className="text-right tabular-nums">
                    {money(f.amount)}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
