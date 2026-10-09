import Link from "next/link";
import { ArrowRight, Hourglass } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { requirePerm } from "@/lib/auth/session";
import { REPORTS, reportStatus } from "@/lib/reports/registry";
import { availableSources } from "@/lib/reports/server";
import { REPORT_GROUPS } from "@/lib/reports/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Reports" };

export default async function ReportsIndexPage() {
  await requirePerm("reports.view");
  const available = await availableSources(createAdminClient());

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Reports" description="Every report shares the same period and filters, and exports to CSV." />
      {REPORT_GROUPS.map((group) => {
        const reports = REPORTS.filter((r) => r.group === group);
        if (reports.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`g-${group}`} className="flex flex-col gap-3">
            <h3 id={`g-${group}`} className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {group}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {reports.map((r) => {
                const status = reportStatus(r, available);
                return (
                  <Link
                    key={r.key}
                    href={`/reports/${r.key}`}
                    className="bg-card hover:bg-accent/40 focus-visible:ring-ring flex flex-col gap-1.5 rounded-xl border p-4 transition-colors outline-none focus-visible:ring-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{r.title}</span>
                      {status === "live" ? <ArrowRight className="text-muted-foreground size-4" aria-hidden /> : <Badge variant="outline" className="gap-1"><Hourglass className="size-3" aria-hidden /> Awaiting</Badge>}
                    </div>
                    <p className="text-muted-foreground text-sm">{r.description}</p>
                    {status !== "live" && r.awaiting && <p className="text-muted-foreground text-xs">Arrives with {r.awaiting}.</p>}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
