import "server-only";

import { loadAccount, toView, type AccountView } from "@/lib/integrations/accounts";
import { INTEGRATIONS, integrationDef, type IntegrationKind } from "@/lib/integrations/catalog";
import {
  CALL_PROVIDERS,
  classifyHealth,
  foldCallStats,
  type HealthState,
} from "@/lib/integrations/health";
import type { AdminClient } from "@/lib/supabase/admin";

export type IntegrationHealthRow = {
  kind: IntegrationKind;
  title: string;
  state: HealthState;
  view: AccountView;
  calls24h: number;
  failed24h: number;
};

/** Health of every catalogued integration for an org (System health and the Integrations hub). */
export async function loadIntegrationHealth(
  admin: AdminClient,
  orgId: string,
  now = new Date(),
): Promise<IntegrationHealthRow[]> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data: stats } = await admin.rpc("integration_call_stats", {
    p_org: orgId,
    p_since: since,
  });
  const rows = (stats ?? []).map((r) => ({
    provider: r.provider,
    outcome: r.outcome,
    calls: Number(r.calls),
  }));
  const out: IntegrationHealthRow[] = [];
  for (const def of INTEGRATIONS) {
    const view = toView(def.kind, await loadAccount(admin, orgId, def.kind));
    const folded = foldCallStats(rows, CALL_PROVIDERS[def.kind]);
    out.push({
      kind: def.kind,
      title: integrationDef(def.kind).title,
      state: classifyHealth(
        {
          enabled: view.enabled,
          outbound: def.outbound,
          breakerOpenUntil: view.breakerOpenUntil,
          lastOkAt: view.lastOkAt,
          lastErrorAt: view.lastErrorAt,
          calls: folded.calls,
          failedCalls: folded.failedCalls,
        },
        now,
      ),
      view,
      calls24h: folded.calls,
      failed24h: folded.failedCalls,
    });
  }
  return out;
}

/** Totals per metric for the last `days` days (messages sent, parts, fetches ...). */
export async function loadUsage(
  admin: AdminClient,
  orgId: string,
  provider: string,
  days = 30,
): Promise<Record<string, number>> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data } = await admin
    .from("integration_usage_daily")
    .select("metric, value")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .gte("day", from);
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.metric] = (out[r.metric] ?? 0) + Number(r.value);
  return out;
}
