import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { loadAccount, readConfig } from "@/lib/integrations/accounts";
import { readCapiConfig } from "@/lib/integrations/capi/config";
import { loadAdReport } from "@/lib/integrations/capi/server";
import {
  formatMilli,
  mergeAdPerformance,
  totalsByCurrency,
} from "@/lib/integrations/meta-ads/cost";
import { loadAdSpend } from "@/lib/integrations/meta-ads/server";
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

const count = (n: number | null) => (n === null ? "n/a" : n.toLocaleString("en"));

export default async function AdReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const member = await requirePerm("ads.view");
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days) as 30 | 90) ? Number(sp.days) : 30;
  const admin = createAdminClient();
  const [account, adsAccount] = await Promise.all([
    loadAccount(admin, member.orgId, "meta_capi"),
    loadAccount(admin, member.orgId, "meta_ads"),
  ]);
  const cfg = readCapiConfig(readConfig(account));
  const on = account?.enabled === true;
  const spendOn = adsAccount?.enabled === true;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [attribution, spendRows] = await Promise.all([
    on ? loadAdReport(admin, member.orgId, days, cfg.windowDays) : Promise.resolve([]),
    spendOn ? loadAdSpend(admin, member.orgId, since.slice(0, 10)) : Promise.resolve([]),
  ]);
  const rows = mergeAdPerformance(attribution, spendRows);
  const currencyTotals = totalsByCurrency(rows);
  const lastPulled = spendRows.reduce<string | null>(
    (a, r) => (r.pulled_at && (!a || r.pulled_at > a) ? r.pulled_at : a),
    null,
  );

  const countEvents = async (status: string) =>
    (
      await admin
        .from("capi_events")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("status", status)
        .gte("created_at", since)
    ).count ?? 0;
  const [queued, sent, failed, skipped] = on
    ? await Promise.all([
        countEvents("queued"),
        countEvents("sent"),
        countEvents("failed"),
        countEvents("skipped"),
      ])
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
        description={`Which Meta ads started WhatsApp conversations in the last ${days} days, how many of those patients then became an enquiry or a booking within ${cfg.windowDays} days of the click, and what the ads cost. Counts and amounts only: no patient is named.`}
      />
      <div className="flex gap-2 text-sm">
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/reports/ads?days=${p}`}
            aria-current={p === days ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${p === days ? "bg-accent" : "hover:bg-accent/40"}`}
          >
            Last {p} days
          </Link>
        ))}
      </div>
      {!on && !spendOn ? (
        <Card>
          <CardHeader>
            <CardTitle>Not switched on</CardTitle>
            <CardDescription>
              Ad attribution is off. An administrator can switch it on under Settings, Integrations,
              Meta ad attribution (conversations, enquiries and bookings per ad) and Meta ads spend
              (cost per ad). Clicks are recorded only from then on.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>By ad</CardTitle>
              <CardDescription>
                {on ? (
                  <>
                    {total.conversations} conversations, {total.enquiries} enquiries and{" "}
                    {total.appointments} bookings in total. A booking counts for an ad when it was
                    created after the click, for the same patient, inside the window; cancelled
                    bookings are not counted.
                  </>
                ) : (
                  <>
                    Meta ad attribution is off, so conversations, enquiries and bookings are not
                    counted and no cost per result can be worked out.
                  </>
                )}
                {spendOn ? (
                  <>
                    {" "}
                    Spend, impressions and clicks are Meta&apos;s own figures, read once a day for
                    the days in this period (Meta&apos;s day, in the ad account&apos;s time zone)
                    {lastPulled
                      ? `, last read ${lastPulled.slice(0, 16).replace("T", " ")} UTC`
                      : ""}
                    .
                  </>
                ) : (
                  <> Meta ads spend is off, so no cost is shown.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {currencyTotals.map((t) => (
                <dl key={t.currency} className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">Spend ({t.currency})</dt>
                    <dd className="tabular-nums">{formatMilli(t.spendMilli, t.currency)}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">Cost per conversation</dt>
                    <dd className="tabular-nums">
                      {formatMilli(t.costPerConversationMilli, t.currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">Cost per enquiry</dt>
                    <dd className="tabular-nums">
                      {formatMilli(t.costPerEnquiryMilli, t.currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">Cost per booking</dt>
                    <dd className="tabular-nums">
                      {formatMilli(t.costPerBookingMilli, t.currency)}
                    </dd>
                  </div>
                </dl>
              ))}
              <div className="overflow-x-auto">
                {rows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No ad conversations or ad spend in this period.
                  </p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-4 font-medium">Ad</th>
                        <th className="py-1 pr-4 font-medium">Conversations</th>
                        <th className="py-1 pr-4 font-medium">Patients</th>
                        <th className="py-1 pr-4 font-medium">Enquiries</th>
                        <th className="py-1 pr-4 font-medium">Bookings</th>
                        {spendOn ? (
                          <>
                            <th className="py-1 pr-4 font-medium">Spend</th>
                            <th className="py-1 pr-4 font-medium">Impressions</th>
                            <th className="py-1 pr-4 font-medium">Clicks</th>
                            <th className="py-1 pr-4 font-medium">Per conversation</th>
                            <th className="py-1 pr-4 font-medium">Per enquiry</th>
                            <th className="py-1 font-medium">Per booking</th>
                          </>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-t">
                          <td className="py-1 pr-4">
                            <div>{r.label}</div>
                            <div className="text-muted-foreground text-xs">
                              {r.campaignName ? `${r.campaignName} · ` : ""}
                              {r.sourceType} {r.sourceId}
                            </div>
                          </td>
                          <td className="py-1 pr-4 tabular-nums">{r.conversations}</td>
                          <td className="py-1 pr-4 tabular-nums">{r.patients}</td>
                          <td className="py-1 pr-4 tabular-nums">{r.enquiries}</td>
                          <td className="py-1 pr-4 tabular-nums">{r.appointments}</td>
                          {spendOn ? (
                            <>
                              <td className="py-1 pr-4 tabular-nums">
                                {r.mixedCurrency
                                  ? "Several currencies"
                                  : formatMilli(r.spendMilli, r.currency)}
                              </td>
                              <td className="py-1 pr-4 tabular-nums">{count(r.impressions)}</td>
                              <td className="py-1 pr-4 tabular-nums">{count(r.clicks)}</td>
                              <td className="py-1 pr-4 tabular-nums">
                                {formatMilli(r.costPerConversationMilli, r.currency)}
                              </td>
                              <td className="py-1 pr-4 tabular-nums">
                                {formatMilli(r.costPerEnquiryMilli, r.currency)}
                              </td>
                              <td className="py-1 tabular-nums">
                                {formatMilli(r.costPerBookingMilli, r.currency)}
                              </td>
                            </>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </CardContent>
          </Card>
          {on ? (
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
          ) : null}
        </>
      )}
    </div>
  );
}
