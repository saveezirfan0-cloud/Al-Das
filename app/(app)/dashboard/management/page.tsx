import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { ChartRenderer } from "@/components/charts/chart-renderer";
import { KpiTile } from "@/components/charts/kpi-tile";
import { AwaitingCard } from "@/components/shell/awaiting-card";
import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { filtersFromSearchParams } from "@/lib/reports/filters";
import { conversationsReport, responseReport, whatsappUsageReport } from "@/lib/reports/queries";
import { REPORTS, reportStatus } from "@/lib/reports/registry";
import { availableSources, filterOptions, reportContext } from "@/lib/reports/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { ReportFilterBar } from "../../reports/report-filter-bar";

export const metadata = { title: "Management dashboard" };

export default async function ManagementDashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requirePerm("reports.view");
  const admin = createAdminClient();
  const available = await availableSources(admin);
  const ready = ["conversations", "response", "whatsapp-usage"].every((k) => {
    const def = REPORTS.find((r) => r.key === k)!;
    return reportStatus(def, available) === "live";
  });

  const { filters, error } = filtersFromSearchParams(await searchParams);
  const ctx = reportContext(member, filters);
  const options = await filterOptions(admin, member.orgId);

  const body = ready
    ? await Promise.all([conversationsReport(ctx), responseReport(ctx), whatsappUsageReport(ctx)])
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Management dashboard" description={`How the clinic is communicating with patients. ${ctx.range.label} (${ctx.timezone}).`} />
      <ReportFilterBar filters={filters} applicable={["channel"]} options={options} />
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error} Showing the default period instead.
        </p>
      )}

      {body ? (
        (() => {
          const [conv, resp, usage] = body;
          const pick = (r: typeof conv, keys: string[]) => r.kpis.filter((k) => keys.includes(k.key));
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[...pick(conv, ["conversations", "unique", "returning"]), ...pick(resp, ["median", "answered"]), ...pick(usage, ["total", "failed"])].map((k) => (
                  <KpiTile key={k.key} label={k.label} value={k.value} format={k.format} hint={k.hint} />
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartRenderer spec={conv.charts[0]} />
                <ChartRenderer spec={resp.charts[0]} />
                <ChartRenderer spec={usage.charts[0]} />
                <ChartRenderer spec={conv.charts[1]} />
              </div>
              <p className="text-sm">
                <Link href="/reports" className="text-primary inline-flex items-center gap-1 underline">
                  Open the full reports <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </p>
            </>
          );
        })()
      ) : (
        <AwaitingCard title="Messaging metrics" phase="the metrics migration" detail="Apply the latest database migrations to enable these widgets." />
      )}

      <section aria-labelledby="coming" className="flex flex-col gap-3">
        <h3 id="coming" className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Arriving with other modules
        </h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <AwaitingCard title="Enquiries in, closed and converted" phase="Phase 5 (enquiries)" />
          <AwaitingCard title="Conversion to appointments" phase="Phase 6 (appointments)" />
          <AwaitingCard title="Appointments by status, location and specialist" phase="Phase 6 (appointments)" />
          <AwaitingCard title="No-shows" phase="Phase 6 (appointments)" detail="Needs the confirmed Unite status codes (OQ-23)." />
          <AwaitingCard title="Campaign results" phase="Phase 7 (campaigns)" />
          <AwaitingCard title="WhatsApp cost" phase="Meta pricing analytics ingestion" detail="Message counts by type are shown above." />
        </div>
      </section>
    </div>
  );
}
