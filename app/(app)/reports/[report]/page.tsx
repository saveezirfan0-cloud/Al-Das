import { notFound } from "next/navigation";

import { ChartRenderer } from "@/components/charts/chart-renderer";
import { KpiTile } from "@/components/charts/kpi-tile";
import { ReportTable } from "@/components/charts/report-table";
import { AwaitingCard } from "@/components/shell/awaiting-card";
import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { filtersFromSearchParams } from "@/lib/reports/filters";
import { getReport, reportStatus } from "@/lib/reports/registry";
import { availableSources, filterOptions, reportContext } from "@/lib/reports/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { ExportButton } from "../export-button";
import { ReportFilterBar } from "../report-filter-bar";

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const def = getReport((await params).report);
  return { title: def ? `${def.title} · Reports` : "Reports" };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("reports.view");
  const def = getReport((await params).report);
  if (!def) notFound();

  const admin = createAdminClient();
  const status = reportStatus(def, await availableSources(admin));

  if (status !== "live") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={def.title} description={def.description} />
        <AwaitingCard
          title={def.title}
          phase={def.awaiting ?? "the metrics migration"}
          detail={status === "unavailable" ? "The data views for this report are missing. Apply the latest database migrations." : undefined}
        />
      </div>
    );
  }

  const { filters, error } = filtersFromSearchParams(await searchParams);
  const ctx = reportContext(member, filters);
  const [result, options] = await Promise.all([def.run!(ctx), filterOptions(admin, member.orgId)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={def.title} description={`${def.description} (${ctx.range.label}, ${ctx.timezone})`}>
        {can(member, "reports.export") && <ExportButton report={def.key} filters={filters} />}
      </PageHeader>
      <ReportFilterBar filters={filters} applicable={def.filters} options={options} />
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error} Showing the default period instead.
        </p>
      )}
      {result.notes.length > 0 && (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {result.kpis.map((k) => (
          <KpiTile key={k.key} label={k.label} value={k.value} format={k.format} hint={k.hint} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {result.charts.map((c) => (
          <div key={c.title} className={c.kind === "heatmap" || (c.kind === "bars" && c.data.length > 14) ? "lg:col-span-2" : undefined}>
            <ChartRenderer spec={c} />
          </div>
        ))}
      </div>
      <section aria-labelledby="table-view" className="flex flex-col gap-2">
        <h3 id="table-view" className="text-sm font-semibold">
          Table view
        </h3>
        <ReportTable table={result.table} />
      </section>
    </div>
  );
}
