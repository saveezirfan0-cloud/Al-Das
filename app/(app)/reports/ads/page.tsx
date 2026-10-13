import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { loadAccount, readConfig } from "@/lib/integrations/accounts";
import { readCapiConfig } from "@/lib/integrations/capi/config";
import { loadAdReport } from "@/lib/integrations/capi/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Ad attribution" };
export const dynamic = "force-dynamic";

const PERIODS = [30, 90] as const;

const SKIP_LABEL: Record<string, string> = {
  no_consent: "Patient had not opted in",
  stopped: "Patient asked to stop marketing",
  unavailable: "Record erased, deleted or merged",
  outside_window: "Outside the attribution window",
  too_old: "Older than Meta accepts (7 days)",
  training: "Training workspace",
  report_only: "Report-only mode",
  integration_off: "Switched off",
};

export default async function AdReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const member = await requirePerm("ads.view");
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days) as 30 | 90) ? Number(sp.days) : 30;
  const admin = createAdminClient();
  const account = await loadAccount(admin, member.orgId, "meta_capi");
  const cfg = readCapiConfig(readConfig(account));
  const on = account?.enabled === true;
  const rows = on ? await loadAdReport(admin, member.orgId, days, cfg.windowDays) : [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const count = async (status: string) =>
    (
      await admin
        .from("capi_events")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("status", status)
        .gte("created_at", since)
    ).count ?? 0;
  const [queued, sent, failed, skipped] = on
    ? await Promise.all([count("queued"), count("sent"), count("failed"), count("skipped")])
    : [0, 0, 0, 0];
  const { data: skips } = on
    ? await admin
        .from("capi_events")
        .select("reason")
        .eq("org_id", member.orgId)
        .eq("status", "skipped")
        .gte("created_at", since)
        .limit(2000)
    : { data: [] };
  const byReason: Record<string, number> = {};
  for (const s of skips ?? [])
    byReason[s.reason ?? "other"] = (byReason[s.reason ?? "other"] ?? 0) + 1;

  const total = rows.reduce(
    (a, r) => ({
      conversations: a.conversations + r.conversations,
      enquiries: a.enquiries + r.enquiries,
      appointments: a.appointments + r.appointments,
    }),
    { conversations: 0, enquiries: 0, appointments: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ad attribution"
        description={`Which Meta ads started WhatsApp conversations in the last ${days} days, and how many of those patients then became an enquiry or a booking within ${cfg.windowDays} days of the click. Counts only: no patient is named.`}
      />
      <div className="flex gap-2 text-sm">
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/reports/ads?days=${p}`}
            className={`rounded-md border px-3 py-1 ${p === days ? "bg-accent" : "hover:bg-accent/40"}`}
          >
            Last {p} days
          </Link>
        ))}
      </div>
      {!on ? (
        <Card>
          <CardHeader>
            <CardTitle>Not switched on</CardTitle>
            <CardDescription>
              Ad attribution is off. An administrator can switch it on under Settings, Integrations,
              Meta ad attribution. Clicks are recorded only from then on.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>By ad</CardTitle>
              <CardDescription>
                {total.conversations} conversations, {total.enquiries} enquiries and{" "}
                {total.appointments} bookings in total. A booking counts for an ad when it was
                created after the click, for the same patient, inside the window; cancelled bookings
                are not counted.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {rows.length === 0 ? (
                <p className="text-muted-foreground text-sm">No ad conversations in this period.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Ad</th>
                      <th className="py-1 pr-4 font-medium">Conversations</th>
                      <th className="py-1 pr-4 font-medium">Patients</th>
                      <th className="py-1 pr-4 font-medium">Enquiries</th>
                      <th className="py-1 font-medium">Bookings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.source_type}:${r.source_id}`} className="border-t">
                        <td className="py-1 pr-4">
                          <div>{r.headline ?? "(no headline)"}</div>
                          <div className="text-muted-foreground text-xs">
                            {r.source_type} {r.source_id}
                          </div>
                        </td>
                        <td className="py-1 pr-4 tabular-nums">{r.conversations}</td>
                        <td className="py-1 pr-4 tabular-nums">{r.patients}</td>
                        <td className="py-1 pr-4 tabular-nums">{r.enquiries}</td>
                        <td className="py-1 tabular-nums">{r.appointments}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Events sent to Meta
                <Badge variant="outline">
                  {cfg.mode === "send_events" ? "Sending" : "Report only"}
                </Badge>
              </CardTitle>
              <CardDescription>
                {cfg.mode === "send_events"
                  ? "Contact, Lead and Schedule events for patients who came from an ad."
                  : "Nothing is sent to Meta in report-only mode."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              {[
                ["Waiting to be sent", queued],
                ["Sent", sent],
                ["Meta refused or failed", failed],
                ["Not sent (see reasons)", skipped],
              ].map(([label, n]) => (
                <div key={String(label)} className="flex justify-between gap-4 border-b py-1">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="tabular-nums">{n}</span>
                </div>
              ))}
              {Object.entries(byReason).map(([reason, n]) => (
                <div key={reason} className="flex justify-between gap-4 border-b py-1">
                  <span className="text-muted-foreground">
                    Not sent: {SKIP_LABEL[reason] ?? reason}
                  </span>
                  <span className="tabular-nums">{n}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
