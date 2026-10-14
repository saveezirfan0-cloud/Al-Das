import "server-only";

import { serverEnv } from "@/lib/env";
import {
  bumpUsage,
  dbBreakerStore,
  dbCallSink,
  readConfig,
  readSecrets,
  recordFailure,
  recordOk,
  type AccountRow,
} from "@/lib/integrations/accounts";
import type { ClientDeps } from "@/lib/integrations/client";
import {
  mayStartWorkspace,
  orderByLastAttempt,
  TASK_DEADLINE_MS,
} from "@/lib/integrations/meta-ads/budget";
import { createMetaAdsClient, type MetaAdsClient } from "@/lib/integrations/meta-ads/client";
import { readMetaAdsConfig } from "@/lib/integrations/meta-ads/config";
import type { SpendTotals } from "@/lib/integrations/meta-ads/cost";
import { insightsRange } from "@/lib/integrations/meta-ads/insights";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * Meta ads spend, server side (Phase 20i, G13).
 *
 *   syncAdInsights        the ads_insights_sync task (pg_cron, daily): for every workspace whose integration is ON and that is not a
 *                         training workspace, reads the last N complete days of ad-level insights and replaces them in
 *                         ad_insights_daily (ad_insights_replace, idempotent). A workspace whose integration is off makes no call.
 *                         Runs inside a 45 s budget (budget.ts): workspaces in order of last attempt, an attempt recorded before
 *                         the first request, no workspace started near the deadline and no request running past it.
 *   loadAdSpend           totals per ad for the Ad attribution report (ad_spend_report).
 *   loadSpendCoverageStart the earliest day Pulse holds spend for (the report divides only like periods).
 *
 * Pull only: nothing about a patient, a conversation or a booking is ever sent to Meta from here.
 */

export type Deps = Partial<Pick<ClientDeps, "fetchFn" | "sleep" | "rng">> & {
  /** The date the pulled range is counted back from. */
  now?: () => Date;
  /** Wall clock for the time budget (epoch ms). */
  clock?: () => number;
  /** Epoch ms after which no Graph request may still run (set by syncAdInsights). */
  deadlineAt?: number;
};

export type OrgSyncOutcome =
  | { outcome: "synced"; rows: number; removed: number; since: string; until: string }
  | { outcome: "off" | "training" | "incomplete" }
  | { outcome: "failed"; code: string };

/** At most this many workspaces per run (one call chain each); the rest wait for the next run. */
export const ORGS_PER_RUN = 50;
/** Enabled accounts read to choose from (ordered by last attempt in code). */
const ACCOUNTS_SCANNED = 1000;
/** Written before a workspace's first request and replaced by success or the real reason; left behind only by a cut-off run. */
export const ATTEMPT_MARKER = "insights pull did not finish";

/** The configured client with call logging and the stored breaker, or null while credentials are missing. */
export function buildMetaAdsClientFor(
  admin: AdminClient,
  account: AccountRow,
  deps: Deps = {},
): MetaAdsClient | null {
  const cfg = readMetaAdsConfig(readConfig(account));
  const secrets = readSecrets(account);
  if (!cfg.adAccountId || !secrets.access_token) return null;
  return createMetaAdsClient({
    adAccountId: cfg.adAccountId,
    accessToken: secrets.access_token,
    graphVersion: cfg.graphVersion ?? serverEnv().META_GRAPH_VERSION,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
    rng: deps.rng,
    now: deps.clock,
    deadlineAt: deps.deadlineAt,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "meta_ads"),
  });
}

/** One workspace: re-checks the switch and training mode, reads the range from Meta and stores it (all or nothing). */
export async function syncAdInsightsForOrg(
  admin: AdminClient,
  account: AccountRow,
  deps: Deps = {},
): Promise<OrgSyncOutcome> {
  const orgId = account.org_id;
  if (!account.enabled || account.kind !== "meta_ads") return { outcome: "off" };
  if (await isTrainingOrg(admin, orgId)) return { outcome: "training" };
  const client = buildMetaAdsClientFor(admin, account, deps);
  if (!client) {
    await recordFailure(admin, orgId, "meta_ads", "ad account id or access token missing");
    return { outcome: "incomplete" };
  }
  const cfg = readMetaAdsConfig(readConfig(account));
  const range = insightsRange((deps.now ?? (() => new Date()))(), cfg.lookbackDays);
  // The attempt is on record before the first request: a run that is cut off leaves this workspace at the back of the queue.
  await recordFailure(admin, orgId, "meta_ads", ATTEMPT_MARKER);
  const pulled = await client.fetchInsights(range);
  if (!pulled.ok) {
    await recordFailure(
      admin,
      orgId,
      "meta_ads",
      `insights ${pulled.auth ? "auth " : ""}${pulled.code}`,
    );
    return { outcome: "failed", code: pulled.code };
  }
  const { data, error } = await admin.rpc("ad_insights_replace", {
    p_org: orgId,
    p_since: range.since,
    p_until: range.until,
    p_rows: pulled.rows,
  });
  if (error) {
    await recordFailure(admin, orgId, "meta_ads", `store failed ${error.code ?? ""}`);
    return { outcome: "failed", code: "store_failed" };
  }
  const result = (data ?? {}) as { upserted?: number; removed?: number };
  await recordOk(admin, orgId, "meta_ads");
  await bumpUsage(admin, orgId, "meta_ads", "insight_rows", pulled.rows.length);
  return {
    outcome: "synced",
    rows: Number(result.upserted ?? pulled.rows.length),
    removed: Number(result.removed ?? 0),
    since: range.since,
    until: range.until,
  };
}

/** The ads_insights_sync task. Counts only in its result (it lands in job_runs). */
export async function syncAdInsights(admin: AdminClient, deps: Deps = {}) {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const deadlineAt = startedAt + TASK_DEADLINE_MS;
  const { data: accounts } = await admin
    .from("integration_accounts")
    .select("*")
    .eq("kind", "meta_ads")
    .eq("enabled", true)
    .limit(ACCOUNTS_SCANNED);
  const queue = orderByLastAttempt(accounts ?? []).slice(0, ORGS_PER_RUN);
  const result = { orgs: 0, synced: 0, rows: 0, failed: 0, skipped: 0, deferred: 0 };
  for (const account of queue) {
    if (!mayStartWorkspace(startedAt, clock())) {
      // Not touched, so it keeps its place at the front for the next run.
      result.deferred++;
      continue;
    }
    result.orgs++;
    try {
      const r = await syncAdInsightsForOrg(admin, account, { ...deps, clock, deadlineAt });
      if (r.outcome === "synced") {
        result.synced++;
        result.rows += r.rows;
      } else if (r.outcome === "failed" || r.outcome === "incomplete") result.failed++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      await recordFailure(admin, account.org_id, "meta_ads", redactText(err, 120));
    }
  }
  return result;
}

/** Spend, impressions and clicks per ad (and currency) from `sinceDay` (YYYY-MM-DD) on. */
export async function loadAdSpend(
  admin: AdminClient,
  orgId: string,
  sinceDay: string,
): Promise<SpendTotals[]> {
  const { data } = await admin.rpc("ad_spend_report", { p_org: orgId, p_since: sinceDay });
  if (!Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    ad_id: String(r.ad_id ?? ""),
    currency: String(r.currency ?? ""),
    ad_name: typeof r.ad_name === "string" ? r.ad_name : null,
    campaign_name: typeof r.campaign_name === "string" ? r.campaign_name : null,
    spend_milli: Number(r.spend_milli) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    days: Number(r.days) || 0,
    pulled_at: typeof r.pulled_at === "string" ? r.pulled_at : null,
  }));
}

/** The earliest day (YYYY-MM-DD) Pulse holds spend for, or null when it holds none (one indexed row). */
export async function loadSpendCoverageStart(
  admin: AdminClient,
  orgId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("ad_insights_daily")
    .select("day")
    .eq("org_id", orgId)
    .order("day", { ascending: true })
    .limit(1);
  const day = data?.[0]?.day;
  return typeof day === "string" ? day : null;
}
