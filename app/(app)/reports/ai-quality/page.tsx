import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { KnowledgeGap, QualityStats } from "@/lib/ai/insights/report";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "AI reply quality" };
export const dynamic = "force-dynamic";

const TOPIC_LABEL: Record<string, string> = {
  opening_hours: "Opening hours",
  location: "Location and directions",
  price: "Prices",
  insurance: "Insurance",
  services: "Services",
  doctors: "Doctors",
  preparation: "Preparing for a visit",
  results: "Results and reports",
  booking: "Booking",
  other: "Something else",
  unclassified: "Not labelled (AI labelling was off)",
};

const FEATURE_LABEL: Record<string, string> = {
  suggest_reply: "Suggested replies",
  summarize: "Summaries",
  ask: "Ask AI",
  rewrite: "Rewrites",
  appeal_draft: "Appeal drafts",
  flow_copilot: "Flow Copilot",
  campaign_audience: "Campaign audiences",
  campaign_copy: "Template wording",
  intent: "Message labels",
};

function Bar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: string;
}) {
  const pct = total ? Math.round((value * 100) / total) : 0;
  return (
    <div className="grid grid-cols-[7rem_1fr_5rem] items-center gap-2 text-sm">
      <span>{label}</span>
      <div className="bg-muted h-2 overflow-hidden rounded-full" aria-hidden>
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-muted-foreground tabular-nums">
        {value} ({pct}%)
      </span>
    </div>
  );
}

export default async function AiQualityPage() {
  const member = await requirePerm("ai.insights.view");
  const supabase = await createClient();
  const { data: reports } = await supabase
    .from("ai_quality_reports")
    .select("id, week_start, week_end, stats, gaps")
    .eq("org_id", member.orgId)
    .order("week_start", { ascending: false })
    .limit(8);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI reply quality"
        description="Each Monday: how staff used AI suggested replies last week, and what patients asked that the knowledge base could not answer. Counts and topics only; no message text is kept in this report."
      />
      {(reports ?? []).length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No report yet. The first one is built on the Monday after AI suggestions have been used
          for a full week.
        </p>
      )}
      {(reports ?? []).map((r) => {
        const stats = r.stats as unknown as QualityStats;
        const gaps = (r.gaps as unknown as KnowledgeGap[]) ?? [];
        const s = stats.suggestions;
        const judged = s.accepted + s.edited + s.rejected;
        return (
          <Card key={r.id}>
            <CardHeader>
              <CardTitle>
                Week of {r.week_start}{" "}
                {s.used_rate !== null && (
                  <Badge variant="secondary">{s.used_rate}% of judged suggestions were used</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {s.total} suggestion{s.total === 1 ? "" : "s"} · {s.unused} not used · {s.flagged}{" "}
                flagged for a careful read · {s.ungrounded} without knowledge-base content ·{" "}
                {s.thumbs_up} thumbs up, {s.thumbs_down} thumbs down
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">
                  What happened to the suggestions that were judged
                </h3>
                <Bar
                  label="Sent as written"
                  value={s.accepted}
                  total={judged}
                  tone="bg-emerald-500"
                />
                <Bar label="Edited, then sent" value={s.edited} total={judged} tone="bg-sky-500" />
                <Bar label="Replaced" value={s.rejected} total={judged} tone="bg-amber-500" />
                <table className="mt-3 text-xs">
                  <caption className="text-muted-foreground mb-1 text-left">
                    AI calls by feature
                  </caption>
                  <tbody>
                    {stats.by_feature.map((f) => (
                      <tr key={f.feature}>
                        <td className="pr-4">{FEATURE_LABEL[f.feature] ?? f.feature}</td>
                        <td className="pr-4 tabular-nums">{f.calls}</td>
                        <td className="text-muted-foreground tabular-nums">
                          {f.errors > 0 ? `${f.errors} failed` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Questions to add to the knowledge base</h3>
                {gaps.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nothing stood out this week.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {gaps.map((g) => (
                      <li key={g.topic} className="rounded-md border p-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{TOPIC_LABEL[g.topic] ?? g.topic}</span>
                          <span className="text-muted-foreground tabular-nums">{g.count}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                          {g.conversation_ids.slice(0, 5).map((id, i) => (
                            <Link key={id} href={`/inbox?c=${id}`} className="underline">
                              Conversation {i + 1}
                            </Link>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-muted-foreground text-xs">
                  These are suggestions where the knowledge base had nothing to ground the answer,
                  or staff marked it unhelpful. Open a conversation (you only see ones you may
                  access) to read the real question, then{" "}
                  <Link href="/settings/knowledge-base" className="underline">
                    add it to the knowledge base
                  </Link>
                  .
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
