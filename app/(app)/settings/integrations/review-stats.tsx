import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { REVIEW_REASON_LABEL } from "@/lib/integrations/reviews/decision";
import type { ReviewStats } from "@/lib/integrations/reviews/server";

/** Counts only: how many review requests were queued, held back by the per-person limit or skipped, and why. No names. */
export function ReviewStatsCard({ stats }: { stats: ReviewStats }) {
  const s = stats.byStatus;
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last 30 days</CardTitle>
        <CardDescription>
          Counts only; no patient is named here. &quot;Queued&quot; means the message was handed to
          WhatsApp.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {total === 0 ? (
          <p className="text-muted-foreground">No review requests yet.</p>
        ) : (
          <>
            <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {[
                ["Waiting to be sent", s.scheduled ?? 0],
                ["Queued to WhatsApp", s.queued ?? 0],
                ["Not delivered by WhatsApp", stats.notDelivered],
                ["Held back (already asked recently)", s.cap_blocked ?? 0],
                ["Skipped", s.skipped ?? 0],
                ["Failed", s.failed ?? 0],
              ].map(([label, n]) => (
                <div key={String(label)} className="flex justify-between gap-4 border-b py-1">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(stats.skippedByReason).length > 0 && (
              <div>
                <h3 className="mb-1 font-medium">Why requests were skipped</h3>
                <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  {Object.entries(stats.skippedByReason)
                    .sort(([, a], [, b]) => b - a)
                    .map(([reason, n]) => (
                      <div key={reason} className="flex justify-between gap-4 border-b py-1">
                        <dt className="text-muted-foreground">
                          {(REVIEW_REASON_LABEL as Record<string, string>)[reason] ?? reason}
                        </dt>
                        <dd className="tabular-nums">{n}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            )}
            {stats.byLocation.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Location</th>
                      <th className="py-1 pr-4 font-medium">Queued</th>
                      <th className="py-1 pr-4 font-medium">Held back</th>
                      <th className="py-1 font-medium">Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byLocation.map((l) => (
                      <tr key={l.location} className="border-t">
                        <td className="py-1 pr-4">{l.location}</td>
                        <td className="py-1 pr-4 tabular-nums">{l.queued}</td>
                        <td className="py-1 pr-4 tabular-nums">{l.cap_blocked}</td>
                        <td className="py-1 tabular-nums">{l.skipped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
