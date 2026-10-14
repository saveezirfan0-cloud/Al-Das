import Link from "next/link";

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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { uuid } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import {
  CALENDAR_KIND_LABEL,
  CONTRACT_LABEL,
  defaultInputs,
  recruitmentInputsSchema,
  SCENARIO_ENGINE,
  type RecruitmentInputs,
  type ScenarioReport,
} from "@/lib/finance/recruitment";
import { loadBenchmarks, loadCalendarEvents } from "@/lib/finance/recruitment-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { RecruitmentCalculator, ViabilityBadge } from "./calculator";
import { CalendarEventButton, DeleteEventButton, DeleteScenarioButton } from "./forms";

export const metadata = { title: "Recruitment calculator" };
export const dynamic = "force-dynamic";

export default async function RecruitmentPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  // profit figures, and the candidate's pay terms are compensation data: both keys are needed to open the page
  const member = await requirePerm("finance.profit.view");
  await requirePerm("finance.costs.compensation");
  const sp = await searchParams;
  const canManage = can(member, "finance.costs.manage");

  const admin = createAdminClient(); // service role AFTER the permission checks
  const [benchmarks, events, { data: saved }] = await Promise.all([
    loadBenchmarks(admin, member),
    loadCalendarEvents(admin, member.orgId),
    admin
      .from("fin_recruitment_scenarios")
      .select("id, title, inputs, result, created_at")
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const scenarios = (saved ?? []).map((s) => {
    const inputs = recruitmentInputsSchema.safeParse(s.inputs);
    const report = s.result as unknown as ScenarioReport | null;
    return {
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      inputs: inputs.success ? inputs.data : null,
      report: report?.engine === SCENARIO_ENGINE ? report : null,
    };
  });
  const opened =
    sp.scenario && uuid.safeParse(sp.scenario).success
      ? scenarios.find((s) => s.id === sp.scenario && s.inputs)
      : undefined;
  const initial: RecruitmentInputs = opened?.inputs ?? defaultInputs(benchmarks.settings);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recruitment calculator"
        description="Would a candidate doctor pay for themselves? Their claimed revenue, run through one cost model and compared with the clinic's own doctors. Every figure here is a scenario."
      >
        {opened && (
          <Button asChild variant="outline">
            <a href={`/api/finance/recruitment/${opened.id}`}>Download Excel</a>
          </Button>
        )}
        {opened && (
          <Button asChild variant="ghost">
            <Link href="/finance/recruitment">New scenario</Link>
          </Button>
        )}
      </PageHeader>

      <Alert>
        <AlertTitle>Scenario</AlertTitle>
        <AlertDescription>
          A projection from claimed revenue and assumed costs, not actual figures and not pay. The
          defaults (conservative factor {benchmarks.settings.conservativePct} %, consumables{" "}
          {benchmarks.settings.consumablesPct} %, gateway {benchmarks.settings.gatewayPct} %) are
          the clinic&apos;s settings
          {can(member, "finance.targets.manage") ? (
            <>
              {" "}
              under{" "}
              <Link className="text-primary underline" href="/finance/flash/settings#recruitment">
                Targets and report lines
              </Link>
            </>
          ) : null}
          . Do not type candidates&apos; names anywhere on this page.
        </AlertDescription>
      </Alert>

      {opened && (
        <p className="text-sm">
          Opened <span className="font-medium">{opened.title}</span>, saved{" "}
          {opened.createdAt.slice(0, 10)}. The figures below are worked out again on today&apos;s
          benchmarks and calendar; the Excel file holds them as saved.
        </p>
      )}

      <RecruitmentCalculator
        key={opened?.id ?? "new"}
        initial={initial}
        initialTitle={opened?.title ?? ""}
        benchmarks={benchmarks}
        events={events}
        canSave={canManage}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved scenarios</CardTitle>
          <CardDescription>
            The figures as they were when saved. Open one to work on it again.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead className="text-right">Revenue / month</TableHead>
                <TableHead className="text-right">Profit / month</TableHead>
                <TableHead>Viability</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {scenarios.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    No saved scenarios yet.
                  </TableCell>
                </TableRow>
              ) : (
                scenarios.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-64 truncate">{s.title}</TableCell>
                    <TableCell className="text-xs">
                      {s.inputs ? CONTRACT_LABEL[s.inputs.contractType] : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(s.report?.result.revenue.total ?? null)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(s.report?.result.profitMonthly ?? null)}
                    </TableCell>
                    <TableCell>
                      {s.report ? <ViabilityBadge v={s.report.result.viability} /> : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{s.createdAt.slice(0, 10)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {s.inputs && (
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/finance/recruitment?scenario=${s.id}`}>Open</Link>
                        </Button>
                      )}
                      <Button asChild variant="ghost" size="sm">
                        <a href={`/api/finance/recruitment/${s.id}`}>Excel</a>
                      </Button>
                      {canManage && <DeleteScenarioButton id={s.id} />}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="calendar">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-base">Seasonal calendar</CardTitle>
            <CardDescription>
              Ramadan and Eid dates for 2026 and 2027 were added from the Emirates Astronomical
              Society and International Astronomical Center forecasts reported in the UAE press.
              Lunar dates move by a day with the moon sighting, so check them against the official
              announcement and untick approximate.
            </CardDescription>
          </div>
          {canManage && <CalendarEventButton />}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-sm">
                    No events.
                  </TableCell>
                </TableRow>
              ) : (
                events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      {e.label}
                      {e.approximate && (
                        <Badge variant="secondary" className="ml-2">
                          approximate
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{CALENDAR_KIND_LABEL[e.kind]}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.startsOn}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.endsOn}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {canManage && (
                        <>
                          <CalendarEventButton event={e} />
                          <DeleteEventButton id={e.id} />
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
