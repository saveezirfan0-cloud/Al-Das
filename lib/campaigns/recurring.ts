import "server-only";

import { segmentAudience } from "@/lib/campaigns/audience";
import { refreshStats } from "@/lib/campaigns/engine";
import {
  nextCronRun,
  recurrenceRunDecision,
  SKIP_REASON_LABEL,
  type RecurrenceSkipReason,
} from "@/lib/campaigns/recurrence";
import { isMarketingCategory } from "@/lib/campaigns/recipients";
import { enqueue, scheduleJob } from "@/lib/jobs/enqueue";
import type { JobLogger } from "@/lib/jobs/types";
import { checkMediaReferences } from "@/lib/media/resolve";
import { createNotification } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Recurring campaigns (Phase 20d). Each run is a scheduled_jobs row ('campaign.recurrence', durable, deduped per run)
 * plus a tick safety net. A run:
 *   1. re-reads the series and drops a stale job (paused, deleted, rescheduled),
 *   2. re-checks the guardrails (number, template, segment, quality, library files, previous run, budget),
 *   3. claims the run atomically in SQL (public.campaign_recurrence_claim), which also creates the run's campaign,
 *   4. schedules the next run, then builds the audience NOW (re-evaluated every time) and starts the campaign.
 * Everything after that is the ordinary campaign engine (consent checks, retries, guardrails, budget).
 */

export const RECURRENCE_JOB_KIND = "campaign.recurrence";

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Durable job for one run; the dedupe key makes a repeated schedule of the same run a no-op. */
export async function scheduleRecurrenceRun(
  rec: { id: string; org_id: string },
  runAt: Date,
): Promise<void> {
  await scheduleJob({
    kind: RECURRENCE_JOB_KIND,
    payload: { recurrence_id: rec.id, run_at: runAt.toISOString() },
    runAt,
    orgId: rec.org_id,
    dedupeKey: `campaign:recur:${rec.id}:${runAt.toISOString()}`,
  });
}

export type RecurrenceRunResult =
  | { outcome: "inactive" | "stale" | "not_claimed" | "no_next_run" }
  | { outcome: "skipped"; reason: RecurrenceSkipReason }
  | { outcome: "started" | "empty" | "failed"; campaignId: string };

export async function runRecurrence(
  admin: AdminClient,
  recurrenceId: string,
  runAtIso: string,
  log: JobLogger,
  now: Date = new Date(),
): Promise<RecurrenceRunResult> {
  const { data: rec } = await admin
    .from("campaign_recurrences")
    .select(
      "id, org_id, name, status, cron, timezone, next_run_at, segment_id, variable_map, created_by, channels(status, waba_id, quality_rating), wa_templates(status, archived_at, waba_id, category, components, variable_map), segments(id)",
    )
    .eq("id", recurrenceId)
    .maybeSingle();
  if (!rec || rec.status !== "active") return { outcome: "inactive" };
  const runAt = new Date(runAtIso);
  if (!rec.next_run_at || new Date(rec.next_run_at).getTime() !== runAt.getTime())
    return { outcome: "stale" };

  // The run after this one: never earlier than now, so a late run does not trigger a burst of catch-up runs.
  const next = nextCronRun(rec.cron, now.getTime() > runAt.getTime() ? now : runAt, rec.timezone);
  if (!next) {
    await admin
      .from("campaign_recurrences")
      .update({ status: "paused", last_run_outcome: "no_next_run" })
      .eq("id", rec.id)
      .eq("next_run_at", rec.next_run_at);
    return { outcome: "no_next_run" };
  }

  const template = rec.wa_templates;
  const components = (template?.components ?? []) as unknown as MetaTemplateComponent[];
  const [{ count: active }, { data: budgetRows }, mediaProblem] = await Promise.all([
    admin
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("recurrence_id", rec.id)
      // A paused run (budget stop, guardrail) never blocks the series: it may never be resumed.
      .in("status", ["preparing", "scheduled", "queued", "sending"]),
    admin.rpc("campaign_budget_status", { p_org: rec.org_id }),
    template
      ? checkMediaReferences(
          admin,
          rec.org_id,
          components,
          stringMap(rec.variable_map),
          stringMap(template.variable_map),
        )
      : Promise.resolve(null),
  ]);
  const budget = budgetRows?.[0]
    ? { used: Number(budgetRows[0].used ?? 0), monthly_limit: budgetRows[0].monthly_limit ?? null }
    : null;
  const decision = recurrenceRunDecision({
    channel: rec.channels,
    template: template
      ? { status: template.status, archived_at: template.archived_at, waba_id: template.waba_id }
      : null,
    segmentExists: !!rec.segment_id && !!rec.segments,
    mediaProblem,
    previousRunActive: (active ?? 0) > 0,
    budget,
  });

  const { data: campaignId, error } = await admin.rpc("campaign_recurrence_claim", {
    p_recurrence_id: rec.id,
    p_run_at: runAt.toISOString(),
    p_next_run_at: next.toISOString(),
    p_skip_reason: decision.run ? undefined : decision.reason,
  });
  if (error) throw new Error(`campaign_recurrence_claim failed: ${error.message}`);
  // The series moved on (claimed here, or by a parallel job that saw the same run): the next run is due either way.
  await scheduleRecurrenceRun(rec, next);

  if (!decision.run) {
    log.warn("recurring campaign run skipped", { recurrenceId: rec.id, reason: decision.reason });
    if (rec.created_by && decision.reason !== "previous_run_active")
      await createNotification(admin, {
        orgId: rec.org_id,
        userId: rec.created_by,
        type: "campaign.recurrence_skipped",
        title: `Recurring campaign skipped: ${rec.name}`,
        body: `This run was not sent because ${SKIP_REASON_LABEL[decision.reason]}. The next run is still scheduled.`,
        payload: { recurrence_id: rec.id },
      });
    return { outcome: "skipped", reason: decision.reason };
  }
  if (!campaignId) return { outcome: "not_claimed" };

  // Build this run's audience from the segment as it is NOW.
  try {
    const { data: org } = await admin
      .from("orgs")
      .select("timezone")
      .eq("id", rec.org_id)
      .maybeSingle();
    const snapshot = await segmentAudience(admin, {
      orgId: rec.org_id,
      segmentId: rec.segment_id!,
      marketing: isMarketingCategory(template?.category),
      timezone: org?.timezone ?? rec.timezone,
      campaignId,
    });
    if (snapshot.counts.tooMany)
      throw new Error("The audience has more than 50,000 contacts. Narrow the segment.");
    await refreshStats(admin, campaignId);
    if (snapshot.counts.eligible === 0) {
      await admin
        .from("campaigns")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          error: "Nobody in the segment could receive it this run.",
        })
        .eq("id", campaignId)
        .eq("status", "preparing");
      return { outcome: "empty", campaignId };
    }
  } catch (err) {
    await admin
      .from("campaigns")
      .update({
        status: "failed",
        error: (err instanceof Error ? err.message : "Building the audience failed.").slice(0, 300),
      })
      .eq("id", campaignId)
      .eq("status", "preparing");
    log.warn("recurring campaign audience failed", { recurrenceId: rec.id, campaignId });
    return { outcome: "failed", campaignId };
  }
  await admin
    .from("campaigns")
    .update({ status: "queued" })
    .eq("id", campaignId)
    .eq("status", "preparing");
  await enqueue("campaign_fanout", { op: "start", campaign_id: campaignId });
  log.info("recurring campaign run started", { recurrenceId: rec.id, campaignId });
  return { outcome: "started", campaignId };
}

/**
 * Tick safety net: an active series whose run time passed more than two minutes ago without being claimed (its job
 * was lost) is run now. Idempotent through the same claim.
 */
export async function runOverdueRecurrences(admin: AdminClient, log: JobLogger): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: overdue } = await admin
    .from("campaign_recurrences")
    .select("id, next_run_at")
    .eq("status", "active")
    .lt("next_run_at", cutoff)
    .limit(20);
  let ran = 0;
  for (const r of overdue ?? []) {
    if (!r.next_run_at) continue;
    const res = await runRecurrence(admin, r.id, r.next_run_at, log);
    if (res.outcome !== "stale" && res.outcome !== "inactive") ran++;
  }
  return ran;
}
