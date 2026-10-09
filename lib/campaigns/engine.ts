import "server-only";

import {
  DISPATCH_BATCH,
  FANOUT_BUDGET_MS,
  MAX_IN_FLIGHT,
  STUCK_MESSAGE_MINUTES,
  tierDailyLimit,
  type CampaignStatus,
} from "@/lib/campaigns/constants";
import { parseFunnel, unresolved } from "@/lib/campaigns/funnel";
import { evaluateGuardrails, parseGuardrails } from "@/lib/campaigns/guardrails";
import { classifyRecipient, isMarketingCategory } from "@/lib/campaigns/recipients";
import { resolveVariables, type VariableContact } from "@/lib/campaigns/variables";
import { emit } from "@/lib/events/emit";
import { enqueue, scheduleJob } from "@/lib/jobs/enqueue";
import type { JobLogger } from "@/lib/jobs/types";
import { createNotification, notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { retryableErrorCodes } from "@/lib/whatsapp/errors";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type CampaignRow = Tables<"campaigns">;

const CAMPAIGN_SELECT =
  "*, channels(id, status, quality_rating, messaging_limit_tier), wa_templates(id, name, status, category, components, variable_map)";

export async function loadCampaign(admin: AdminClient, id: string) {
  const { data, error } = await admin
    .from("campaigns")
    .select(CAMPAIGN_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`campaign load failed: ${error.message}`);
  return data;
}
type LoadedCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

async function enqueueOutboundBatch(admin: AdminClient, messageIds: string[]): Promise<void> {
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500).map((id) => ({ message_id: id }));
    const { error } = await admin.rpc("job_enqueue_batch", {
      p_queue: "outbound",
      p_payloads: chunk as unknown as Json[],
      p_delay: 0,
    });
    if (error) throw new Error(`outbound enqueue failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** scheduled | queued → sending (idempotent: a no-op when the campaign moved on). */
export async function startCampaign(admin: AdminClient, id: string): Promise<boolean> {
  const campaign = await loadCampaign(admin, id);
  if (!campaign || !["scheduled", "queued"].includes(campaign.status)) return false;
  const now = new Date().toISOString();
  const { data: started } = await admin
    .from("campaigns")
    .update({
      status: "sending",
      started_at: now,
      guard_since: now,
      quality_at_start: campaign.channels?.quality_rating ?? null,
      error: null,
    })
    .eq("id", id)
    .in("status", ["scheduled", "queued"])
    .select("id")
    .maybeSingle();
  if (!started) return false;
  await emit(campaign.org_id, "campaign.started", { campaign_id: id });
  await enqueue("campaign_fanout", { op: "fanout", campaign_id: id });
  return true;
}

export async function pauseCampaign(
  admin: AdminClient,
  campaign: Pick<CampaignRow, "id" | "org_id" | "name" | "created_by">,
  reason: string,
  opts: { auto?: boolean } = {},
): Promise<boolean> {
  const { data } = await admin
    .from("campaigns")
    .update({
      status: "paused",
      paused_at: new Date().toISOString(),
      paused_reason: reason.slice(0, 500),
    })
    .eq("id", campaign.id)
    .in("status", ["queued", "sending"])
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await emit(campaign.org_id, "campaign.paused", {
    campaign_id: campaign.id,
    auto: !!opts.auto,
    reason,
  });
  if (opts.auto) {
    await notifyMembersWithPermission(admin, campaign.org_id, "campaigns.create", {
      type: "campaign.paused",
      title: `Campaign paused: ${campaign.name}`,
      body: reason,
      payload: { campaign_id: campaign.id },
    });
  }
  return true;
}

export async function resumeCampaign(admin: AdminClient, id: string): Promise<boolean> {
  const campaign = await loadCampaign(admin, id);
  if (!campaign || campaign.status !== "paused") return false;
  const now = new Date().toISOString();
  const { data } = await admin
    .from("campaigns")
    .update({
      status: "sending",
      paused_at: null,
      paused_reason: null,
      guard_since: now, // guardrails count outcomes from here; the person resuming accepted the earlier ones
      quality_at_start: campaign.channels?.quality_rating ?? campaign.quality_at_start,
    })
    .eq("id", id)
    .eq("status", "paused")
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await emit(campaign.org_id, "campaign.resumed", { campaign_id: id });
  await enqueue("campaign_fanout", { op: "fanout", campaign_id: id });
  return true;
}

export async function cancelCampaign(admin: AdminClient, id: string): Promise<boolean> {
  const campaign = await loadCampaign(admin, id);
  if (!campaign) return false;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), next_retry_at: null })
    .eq("id", id)
    .in("status", ["scheduled", "queued", "sending", "paused"])
    .select("id")
    .maybeSingle();
  if (!data) return false;
  // Nothing more goes out: pending rows are closed, queued messages are released by the outbound guard.
  await admin
    .from("campaign_recipients")
    .update({ status: "skipped", skip_reason: "cancelled" })
    .eq("campaign_id", id)
    .eq("status", "pending");
  await emit(campaign.org_id, "campaign.cancelled", { campaign_id: id });
  await refreshStats(admin, id);
  return true;
}

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

function previewBody(components: MetaTemplateComponent[], values: Record<string, string>): string {
  const p = renderTemplatePreview(components, values);
  return [p.headerText, p.body].filter(Boolean).join("\n");
}

type PendingRecipient = {
  id: string;
  contact_id: string;
  csv_data: Json;
  contacts:
    | (VariableContact & {
        wa_bsuid: string | null;
        promotions_opt_in: boolean;
        stop_marketing: boolean;
        deleted_at: string | null;
      })
    | null;
};

/**
 * One fanout pass: dispatch pending recipients in batches until the work is
 * done, the time budget is spent, the in-flight cap or the number's daily
 * messaging limit is reached, or a guardrail pauses the campaign. Re-enqueues
 * itself when there is more to do. Idempotent: campaign_dispatch only touches
 * rows that are still pending (SKIP LOCKED).
 */
export async function runFanout(
  admin: AdminClient,
  id: string,
  log: JobLogger,
): Promise<{ dispatched: number; skipped: number; state: string }> {
  const startedAt = Date.now();
  let dispatched = 0;
  let skipped = 0;

  for (;;) {
    const campaign = await loadCampaign(admin, id);
    if (!campaign || campaign.status !== "sending")
      return { dispatched, skipped, state: campaign?.status ?? "missing" };
    const { channels: channel, wa_templates: template } = campaign;
    if (!channel || !template) {
      await admin
        .from("campaigns")
        .update({ status: "failed", error: "Number or template was removed." })
        .eq("id", id);
      return { dispatched, skipped, state: "failed" };
    }

    const verdict = await checkGuardrails(admin, campaign);
    if (verdict.pause) {
      await pauseCampaign(admin, campaign, verdict.reason, { auto: true });
      log.warn("campaign auto-paused", { campaignId: id, code: verdict.code });
      return { dispatched, skipped, state: "paused" };
    }

    if (Date.now() - startedAt > FANOUT_BUDGET_MS) {
      await enqueue("campaign_fanout", { op: "fanout", campaign_id: id }, { delaySeconds: 1 });
      return { dispatched, skipped, state: "continued" };
    }

    // Back-pressure: do not bury the outbound queue (reminders and flows share it).
    const { count: inFlight } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .eq("status", "queued");
    const room = MAX_IN_FLIGHT - (inFlight ?? 0);
    if (room <= 0) {
      await enqueue("campaign_fanout", { op: "fanout", campaign_id: id }, { delaySeconds: 15 });
      return { dispatched, skipped, state: "waiting_for_queue" };
    }

    // Meta caps unique business-initiated contacts per rolling 24 h by tier.
    let limit = room;
    const tierLimit = tierDailyLimit(channel.messaging_limit_tier);
    if (tierLimit) {
      const { count: used } = await admin
        .from("campaign_recipients")
        .select("id, campaigns!inner(channel_id)", { count: "exact", head: true })
        .eq("campaigns.channel_id", channel.id)
        .gte("dispatched_at", new Date(Date.now() - 24 * 3600_000).toISOString());
      const remaining = Math.floor(tierLimit * 0.9) - (used ?? 0);
      if (remaining <= 0) {
        await admin
          .from("campaigns")
          .update({ error: "Waiting for the number's 24-hour messaging limit to free up." })
          .eq("id", id);
        await enqueue("campaign_fanout", { op: "fanout", campaign_id: id }, { delaySeconds: 600 });
        return { dispatched, skipped, state: "waiting_for_tier" };
      }
      limit = Math.min(limit, remaining);
    }

    const { data: pending, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, contact_id, csv_data, contacts(first_name, last_name, full_name, wa_profile_name, phone_e164, wa_bsuid, email, custom, promotions_opt_in, stop_marketing, deleted_at)",
      )
      .eq("campaign_id", id)
      .eq("status", "pending")
      .order("created_at")
      .order("id")
      .limit(Math.min(DISPATCH_BATCH, limit));
    if (error) throw new Error(`pending recipients read failed: ${error.message}`);
    const batch = (pending ?? []) as unknown as PendingRecipient[];
    if (batch.length === 0) return { dispatched, skipped, state: "drained" };

    const marketing = isMarketingCategory(template.category);
    const components = template.components as unknown as MetaTemplateComponent[];
    const map = stringMap(campaign.variable_map);
    const templateMap = stringMap(template.variable_map);
    const fallbacks = stringMap(campaign.fallbacks);

    const items: Array<Record<string, Json>> = [];
    for (const r of batch) {
      // Re-check consent right before sending: 131050 or an opt-out can land mid-campaign.
      const skip = classifyRecipient(r.contacts, { marketing });
      if (skip) {
        items.push({ recipient_id: r.id, skip });
        continue;
      }
      const resolved = resolveVariables({
        components,
        map,
        templateMap,
        fallbacks,
        contact: {
          ...r.contacts,
          custom:
            r.contacts?.custom &&
            typeof r.contacts.custom === "object" &&
            !Array.isArray(r.contacts.custom)
              ? (r.contacts.custom as Record<string, unknown>)
              : {},
        },
        csv: stringMap(r.csv_data),
      });
      if (resolved.missing.length) {
        items.push({ recipient_id: r.id, skip: `missing_variable:${resolved.missing[0]}` });
        continue;
      }
      items.push({
        recipient_id: r.id,
        body: previewBody(components, resolved.values),
        spec: { type: "template", template_id: template.id, values: resolved.values },
        vars: resolved.values,
      });
    }

    const { data: out, error: dispatchErr } = await admin.rpc("campaign_dispatch", {
      p_campaign_id: id,
      p_items: items as unknown as Json,
    });
    if (dispatchErr) throw new Error(`campaign_dispatch failed: ${dispatchErr.message}`);
    const messageIds = (out ?? []).map((o) => o.message_id);
    await enqueueOutboundBatch(admin, messageIds);
    dispatched += messageIds.length;
    skipped += items.length - messageIds.length;
    if (messageIds.length === 0 && items.length === 0)
      return { dispatched, skipped, state: "drained" };
  }
}

// ---------------------------------------------------------------------------
// Guardrails, stats, completion, retry rounds
// ---------------------------------------------------------------------------

async function checkGuardrails(admin: AdminClient, campaign: LoadedCampaign) {
  const since = campaign.guard_since ?? campaign.started_at ?? campaign.created_at;
  const [{ count: sentSince }, failed] = await Promise.all([
    admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .gte("sent_at", since),
    admin
      .from("campaign_recipients")
      .select("error_code")
      .eq("campaign_id", campaign.id)
      .eq("status", "failed")
      .gte("failed_at", since)
      .limit(5000),
  ]);
  const byCode = new Map<number | null, number>();
  for (const f of failed.data ?? []) byCode.set(f.error_code, (byCode.get(f.error_code) ?? 0) + 1);
  return evaluateGuardrails({
    guardrails: parseGuardrails(campaign.guardrails),
    sentSince: sentSince ?? 0,
    failedByCode: [...byCode].map(([code, count]) => ({ code, count })),
    channel: {
      status: campaign.channels?.status ?? "disconnected",
      quality_rating: campaign.channels?.quality_rating ?? null,
    },
    qualityAtStart: campaign.quality_at_start,
    template: { status: campaign.wa_templates?.status ?? "DELETED" },
  });
}

export async function refreshStats(admin: AdminClient, id: string) {
  const { data, error } = await admin.rpc("campaign_funnel", { p_campaign_id: id });
  if (error) throw new Error(`campaign_funnel failed: ${error.message}`);
  await admin
    .from("campaigns")
    .update({
      stats: (data ?? {}) as NonNullable<Json>,
      stats_refreshed_at: new Date().toISOString(),
    })
    .eq("id", id);
  return parseFunnel(data);
}

/** Messages that never reached the outbound queue (enqueue failed after dispatch) are pushed again. */
async function sweepStuckMessages(admin: AdminClient, id: string): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_MESSAGE_MINUTES * 60_000).toISOString();
  const { data: stuck } = await admin
    .from("campaign_recipients")
    .select("message_id")
    .eq("campaign_id", id)
    .eq("status", "queued")
    .lt("dispatched_at", cutoff)
    .not("message_id", "is", null)
    .limit(200);
  const ids = (stuck ?? []).map((s) => s.message_id).filter((m): m is string => !!m);
  if (ids.length === 0) return 0;
  const { data: msgs } = await admin
    .from("messages")
    .select("id")
    .in("id", ids)
    .eq("status", "queued");
  const queued = (msgs ?? []).map((m) => m.id);
  if (queued.length) await enqueueOutboundBatch(admin, queued);
  return queued.length;
}

/**
 * Stats op, run by the campaign tick for every live campaign: refresh the funnel,
 * evaluate guardrails, re-push stuck messages, restart a stalled fanout, and when
 * nothing is left in flight either schedule the next retry round or complete.
 */
export async function refreshCampaign(
  admin: AdminClient,
  id: string,
  log: JobLogger,
): Promise<{ status: string; unresolved: number }> {
  const campaign = await loadCampaign(admin, id);
  if (!campaign) return { status: "missing", unresolved: 0 };
  const funnel = await refreshStats(admin, id);
  if (campaign.status !== "sending" && campaign.status !== "queued")
    return { status: campaign.status, unresolved: unresolved(funnel) };

  if (campaign.status === "sending") {
    const verdict = await checkGuardrails(admin, campaign);
    if (verdict.pause) {
      await pauseCampaign(admin, campaign, verdict.reason, { auto: true });
      log.warn("campaign auto-paused", { campaignId: id, code: verdict.code });
      return { status: "paused", unresolved: unresolved(funnel) };
    }

    if (funnel.queued > 0) {
      const swept = await sweepStuckMessages(admin, id);
      if (swept) log.warn("re-queued stuck campaign messages", { campaignId: id, swept });
    }

    if (funnel.pending > 0 && funnel.queued === 0 && !campaign.next_retry_at) {
      // Pending work but nothing in flight: make sure a fanout is running (restart after a crash/deploy).
      const { data: last } = await admin
        .from("campaign_recipients")
        .select("dispatched_at")
        .eq("campaign_id", id)
        .not("dispatched_at", "is", null)
        .order("dispatched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const idleMs = last?.dispatched_at
        ? Date.now() - new Date(last.dispatched_at).getTime()
        : Infinity;
      const startedMs = campaign.started_at
        ? Date.now() - new Date(campaign.started_at).getTime()
        : Infinity;
      if (idleMs > 90_000 && startedMs > 90_000) {
        await enqueue("campaign_fanout", { op: "fanout", campaign_id: id });
        log.info("restarted stalled fanout", { campaignId: id });
      }
    }

    if (unresolved(funnel) === 0) await finishOrRetry(admin, campaign, log);
  }
  return { status: campaign.status, unresolved: unresolved(funnel) };
}

async function finishOrRetry(admin: AdminClient, campaign: LoadedCampaign, log: JobLogger) {
  if (campaign.retry_round < campaign.retry_rounds) {
    const { count: retryable } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("status", "failed")
      .in("error_code", retryableErrorCodes());
    if ((retryable ?? 0) > 0) {
      if (!campaign.next_retry_at) {
        const runAt = new Date(Date.now() + campaign.retry_delay_minutes * 60_000);
        const round = campaign.retry_round + 1;
        await scheduleJob({
          kind: "campaign.retry_round",
          payload: { campaign_id: campaign.id, round },
          runAt,
          orgId: campaign.org_id,
          dedupeKey: `campaign:retry:${campaign.id}:${round}`,
        });
        await admin
          .from("campaigns")
          .update({ next_retry_at: runAt.toISOString() })
          .eq("id", campaign.id);
        log.info("retry round scheduled", { campaignId: campaign.id, round });
      }
      return;
    }
  }
  const { data } = await admin
    .from("campaigns")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      next_retry_at: null,
      error: null,
    })
    .eq("id", campaign.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
  if (!data) return;
  await emit(campaign.org_id, "campaign.completed", { campaign_id: campaign.id });
  if (campaign.created_by)
    await createNotification(admin, {
      orgId: campaign.org_id,
      userId: campaign.created_by,
      type: "campaign.completed",
      title: `Campaign finished: ${campaign.name}`,
      payload: { campaign_id: campaign.id },
    });
}

/** `campaign.retry_round` scheduled job: re-queue retryable failures and fan out again. */
export async function runRetryRound(
  admin: AdminClient,
  id: string,
  round: number,
  log: JobLogger,
): Promise<boolean> {
  const campaign = await loadCampaign(admin, id);
  if (!campaign || campaign.status !== "sending" || campaign.retry_round !== round - 1)
    return false;
  const { data: count, error } = await admin.rpc("campaign_requeue_failed", {
    p_campaign_id: id,
    p_codes: retryableErrorCodes(),
  });
  if (error) throw new Error(`campaign_requeue_failed failed: ${error.message}`);
  if (!count) {
    await finishOrRetry(admin, { ...campaign, retry_round: campaign.retry_rounds }, log);
    return false;
  }
  await admin
    .from("campaigns")
    .update({ retry_round: round, next_retry_at: null, guard_since: new Date().toISOString() })
    .eq("id", id)
    .eq("retry_round", round - 1);
  await enqueue("campaign_fanout", { op: "fanout", campaign_id: id });
  log.info("retry round started", { campaignId: id, round, recipients: count });
  return true;
}

// ---------------------------------------------------------------------------
// Outbound guard
// ---------------------------------------------------------------------------

/**
 * Called by the outbound handler before it sends a campaign message. A paused or
 * cancelled campaign, or a contact who opted out since dispatch, must not receive
 * it: the queued message is withdrawn and the recipient put back (paused) or skipped.
 */
export async function guardCampaignMessage(
  admin: AdminClient,
  messageId: string,
  recipientId: string,
  contact: { stop_marketing: boolean },
): Promise<"send" | "released"> {
  const { data: r } = await admin
    .from("campaign_recipients")
    .select("id, campaigns(status, wa_templates(category))")
    .eq("id", recipientId)
    .maybeSingle();
  const status = r?.campaigns?.status as CampaignStatus | undefined;
  if (!r || !status) return "send";

  let release: { status: "pending" | "skipped"; reason: string | null } | null = null;
  if (status === "cancelled") release = { status: "skipped", reason: "cancelled" };
  else if (status === "paused") release = { status: "pending", reason: null };
  else if (isMarketingCategory(r.campaigns?.wa_templates?.category) && contact.stop_marketing)
    release = { status: "skipped", reason: "stop_marketing" };
  if (!release) return "send";

  await admin
    .from("campaign_recipients")
    .update({ status: release.status, skip_reason: release.reason, message_id: null })
    .eq("id", recipientId);
  await admin.from("messages").delete().eq("id", messageId).eq("status", "queued");
  return "released";
}
