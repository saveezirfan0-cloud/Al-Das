/**
 * The weekly reply-quality report. PURE aggregation over rows the job has already read. The report holds COUNTS and
 * conversation ids: no suggestion text, no patient message, no staff message. Topics come from a closed list.
 */
import { TOPICS, type Topic } from "@/lib/ai/intent/intent";

export type UsageRow = {
  id: string;
  feature: string;
  status: string;
  conversation_id: string | null;
  created_at: string;
  grounded: boolean | null;
  input_tokens: number;
  output_tokens: number;
};
export type OutcomeRow = { ai_usage_id: string; outcome: string };
export type FeedbackRow = { ai_usage_id: string | null; positive: boolean };
export type IntentRow = { conversation_id: string; topic: string | null; created_at: string };

export type QualityStats = {
  suggestions: {
    total: number;
    accepted: number;
    edited: number;
    rejected: number;
    /** Suggested, but nothing was sent from it (no verdict recorded). */
    unused: number;
    flagged: number;
    refused: number;
    errors: number;
    ungrounded: number;
    thumbs_up: number;
    thumbs_down: number;
    /** accepted + edited as a share of the suggestions that got a verdict (percent), or null with no verdicts. */
    used_rate: number | null;
  };
  by_feature: Array<{
    feature: string;
    calls: number;
    errors: number;
    input_tokens: number;
    output_tokens: number;
  }>;
};

export type KnowledgeGap = {
  topic: Topic | "unclassified";
  count: number;
  conversation_ids: string[];
};

export const MAX_GAP_IDS = 10;
const TOPIC_SET: ReadonlySet<string> = new Set(TOPICS);

/** The topic of the patient's message that was most recent when the suggestion was made. */
export function topicFor(usage: UsageRow, intents: readonly IntentRow[]): Topic | "unclassified" {
  if (!usage.conversation_id) return "unclassified";
  const at = new Date(usage.created_at).getTime();
  let best: IntentRow | null = null;
  for (const i of intents) {
    if (i.conversation_id !== usage.conversation_id) continue;
    const t = new Date(i.created_at).getTime();
    if (t <= at && (!best || t > new Date(best.created_at).getTime())) best = i;
  }
  return best?.topic && TOPIC_SET.has(best.topic) ? (best.topic as Topic) : "unclassified";
}

export function buildQualityReport(input: {
  usage: readonly UsageRow[];
  outcomes: readonly OutcomeRow[];
  feedback: readonly FeedbackRow[];
  intents: readonly IntentRow[];
}): { stats: QualityStats; gaps: KnowledgeGap[] } {
  const outcomeBy = new Map(input.outcomes.map((o) => [o.ai_usage_id, o.outcome]));
  const feedbackBy = new Map<string, boolean>();
  for (const f of input.feedback) if (f.ai_usage_id) feedbackBy.set(f.ai_usage_id, f.positive);

  const s = {
    total: 0,
    accepted: 0,
    edited: 0,
    rejected: 0,
    unused: 0,
    flagged: 0,
    refused: 0,
    errors: 0,
    ungrounded: 0,
    thumbs_up: 0,
    thumbs_down: 0,
  };
  const byFeature = new Map<
    string,
    { calls: number; errors: number; input_tokens: number; output_tokens: number }
  >();
  const gapIds = new Map<Topic | "unclassified", Set<string>>();
  const gapCount = new Map<Topic | "unclassified", number>();

  for (const u of input.usage) {
    const f = byFeature.get(u.feature) ?? {
      calls: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
    f.calls += 1;
    if (u.status === "error") f.errors += 1;
    f.input_tokens += u.input_tokens;
    f.output_tokens += u.output_tokens;
    byFeature.set(u.feature, f);

    if (u.feature !== "suggest_reply") continue;
    if (u.status === "error") {
      s.errors += 1;
      continue;
    }
    if (u.status === "refused") {
      s.refused += 1;
      continue;
    }
    s.total += 1;
    if (u.status === "needs_review") s.flagged += 1;
    const verdict = outcomeBy.get(u.id);
    if (verdict === "accepted") s.accepted += 1;
    else if (verdict === "edited") s.edited += 1;
    else if (verdict === "rejected") s.rejected += 1;
    else s.unused += 1;
    const vote = feedbackBy.get(u.id);
    if (vote === true) s.thumbs_up += 1;
    if (vote === false) s.thumbs_down += 1;
    if (u.grounded === false) s.ungrounded += 1;

    // A knowledge gap: the knowledge base had nothing for it, or a person marked the suggestion unhelpful.
    if (u.grounded === false || vote === false) {
      const topic = topicFor(u, input.intents);
      gapCount.set(topic, (gapCount.get(topic) ?? 0) + 1);
      if (u.conversation_id) {
        const ids = gapIds.get(topic) ?? new Set<string>();
        if (ids.size < MAX_GAP_IDS) ids.add(u.conversation_id);
        gapIds.set(topic, ids);
      }
    }
  }

  const judged = s.accepted + s.edited + s.rejected;
  const gaps: KnowledgeGap[] = [...gapCount.entries()]
    .map(([topic, count]) => ({ topic, count, conversation_ids: [...(gapIds.get(topic) ?? [])] }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));

  return {
    stats: {
      suggestions: {
        ...s,
        used_rate: judged ? Math.round(((s.accepted + s.edited) * 100) / judged) : null,
      },
      by_feature: [...byFeature.entries()]
        .map(([feature, v]) => ({ feature, ...v }))
        .sort((a, b) => b.calls - a.calls || a.feature.localeCompare(b.feature)),
    },
    gaps,
  };
}

/** Monday (UTC) of the week that contains `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/** The most recent COMPLETE week before `now`: [start, endExclusive). */
export function lastCompleteWeek(now: Date): { start: string; end: string } {
  const thisWeek = weekStartOf(now);
  const end = new Date(`${thisWeek}T00:00:00.000Z`);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: thisWeek };
}
