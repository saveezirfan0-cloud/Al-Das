import "server-only";

import {
  buildQualityReport,
  lastCompleteWeek,
  type FeedbackRow,
  type IntentRow,
  type OutcomeRow,
  type UsageRow,
} from "@/lib/ai/insights/report";
import { readAiSettings } from "@/lib/ai/settings";
import type { JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

const PAGE = 1000;
const MAX_PAGES = 30;
const CHUNK = 100;

async function pages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await fetchPage(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw new Error("report query failed");
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export type WeeklyTotals = { orgs: number; reports: number; skipped: number };

/**
 * Builds last week's reply-quality report for every organisation that uses AI. Idempotent: a report exists once per
 * organisation and week (unique key), so a re-run or an overlapping run adds nothing and tells nobody twice.
 * Stores counts, closed topics and conversation ids. Never any message or suggestion text.
 */
export async function runQualityReports(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<WeeklyTotals> {
  const week = lastCompleteWeek(now);
  const totals: WeeklyTotals = { orgs: 0, reports: 0, skipped: 0 };
  const { data: orgs } = await admin.from("orgs").select("id, settings");
  for (const org of orgs ?? []) {
    if (!readAiSettings(org.settings).enabled) continue;
    totals.orgs++;
    const { data: existing } = await admin
      .from("ai_quality_reports")
      .select("id")
      .eq("org_id", org.id)
      .eq("week_start", week.start)
      .maybeSingle();
    if (existing) {
      totals.skipped++;
      continue;
    }
    const from = `${week.start}T00:00:00.000Z`;
    const to = `${week.end}T00:00:00.000Z`;
    const usage = await pages<UsageRow>((a, b) =>
      admin
        .from("ai_usage")
        .select(
          "id, feature, status, conversation_id, created_at, grounded, input_tokens, output_tokens",
        )
        .eq("org_id", org.id)
        .gte("created_at", from)
        .lt("created_at", to)
        .order("created_at")
        .range(a, b),
    );
    if (usage.length === 0) {
      totals.skipped++;
      continue;
    }
    const ids = new Set(usage.map((u) => u.id));
    const outcomeLate = new Date(new Date(to).getTime() + 3 * 86_400_000).toISOString();
    const outcomes = (
      await pages<OutcomeRow>((a, b) =>
        admin
          .from("ai_suggestion_outcomes")
          .select("ai_usage_id, outcome")
          .eq("org_id", org.id)
          .gte("created_at", from)
          .lt("created_at", outcomeLate)
          .range(a, b),
      )
    ).filter((o) => ids.has(o.ai_usage_id));
    const feedback = (
      await pages<FeedbackRow>((a, b) =>
        admin
          .from("kb_feedback")
          .select("ai_usage_id, positive")
          .eq("org_id", org.id)
          .gte("created_at", from)
          .lt("created_at", outcomeLate)
          .range(a, b),
      )
    ).filter((f) => f.ai_usage_id && ids.has(f.ai_usage_id));

    // Topics only for the conversations that look like gaps.
    const gapIds = new Set<string>();
    const thumbsDown = new Set(feedback.filter((f) => !f.positive).map((f) => f.ai_usage_id));
    for (const u of usage)
      if (
        u.feature === "suggest_reply" &&
        u.conversation_id &&
        (u.grounded === false || thumbsDown.has(u.id))
      )
        gapIds.add(u.conversation_id);
    const intents: IntentRow[] = [];
    const list = [...gapIds];
    for (let i = 0; i < list.length; i += CHUNK) {
      const { data } = await admin
        .from("ai_message_intents")
        .select("conversation_id, topic, created_at")
        .eq("org_id", org.id)
        .eq("source", "model")
        .in("conversation_id", list.slice(i, i + CHUNK))
        .lt("created_at", to);
      intents.push(...(data ?? []));
    }

    const report = buildQualityReport({ usage, outcomes, feedback, intents });
    const { error } = await admin.from("ai_quality_reports").insert({
      org_id: org.id,
      week_start: week.start,
      week_end: week.end,
      stats: report.stats as unknown as NonNullable<Json>,
      gaps: report.gaps as unknown as NonNullable<Json>,
    });
    if (error) {
      if (error.code === "23505") totals.skipped++;
      else log.error("ai quality report insert failed", { code: error.code });
      continue;
    }
    totals.reports++;
    const people = await memberIdsWithPermission(admin, org.id, "ai.insights.view");
    if (people.length) {
      await notify(admin, {
        orgId: org.id,
        userIds: people,
        event: "ai.insights_ready",
        type: "ai.insights_ready",
        title: "Weekly AI report is ready",
        body: "Open it to see how staff used AI suggestions and what patients asked that the knowledge base could not answer.",
        payload: { week_start: week.start },
        ids: {},
      });
    }
  }
  log.info("ai quality reports", totals);
  return totals;
}
