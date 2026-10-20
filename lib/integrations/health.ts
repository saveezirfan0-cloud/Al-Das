import type { IntegrationKind } from "@/lib/integrations/catalog";

/**
 * Health of an integration for the Settings page and System health (pure classification).
 *   off       switched off
 *   idle      on, but no call has been made yet
 *   ok        recent calls succeed (or it makes none: calendar feeds)
 *   degraded  some recent calls failed, or the last thing that happened was an error
 *   down      the circuit breaker is open, or most recent calls failed
 */

export type HealthState = "off" | "idle" | "ok" | "degraded" | "down";

export type HealthInput = {
  enabled: boolean;
  outbound: boolean;
  breakerOpenUntil: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  /** Calls in the last 24 hours. */
  calls: number;
  failedCalls: number;
};

export function classifyHealth(i: HealthInput, now: Date): HealthState {
  if (!i.enabled) return "off";
  if (!i.outbound) return "ok";
  if (i.breakerOpenUntil && new Date(i.breakerOpenUntil) > now) return "down";
  if (i.calls >= 3 && i.failedCalls / i.calls >= 0.5) return "down";
  const errorIsLatest =
    !!i.lastErrorAt && (!i.lastOkAt || new Date(i.lastErrorAt) > new Date(i.lastOkAt));
  if (i.failedCalls > 0 || errorIsLatest) return "degraded";
  if (i.calls === 0 && !i.lastOkAt) return "idle";
  return "ok";
}

export const HEALTH_LABEL: Record<HealthState, string> = {
  off: "Off",
  idle: "On, not used yet",
  ok: "Healthy",
  degraded: "Some failures",
  down: "Failing",
};

export type CallStatRow = { provider: string; outcome: string; calls: number };

/** Folds the per-outcome rows from integration_call_stats() into totals. */
export function foldCallStats(
  rows: readonly CallStatRow[],
  providers: readonly string[],
): { calls: number; failedCalls: number } {
  let calls = 0;
  let failedCalls = 0;
  for (const r of rows) {
    if (!providers.includes(r.provider)) continue;
    calls += Number(r.calls);
    if (r.outcome !== "ok") failedCalls += Number(r.calls);
  }
  return { calls, failedCalls };
}

/** The provider names a kind writes into integration_calls (its adapters' `provider` ids). */
export const CALL_PROVIDERS: Record<IntegrationKind, readonly string[]> = {
  calendar_ics: [],
  // Phase 20h: the generic HTTP gateway logs as "sms_http" (lib/integrations/sms/http.ts).
  sms: ["twilio", "sms_http"],
  payments: ["stripe", "paytabs"],
  // Google review requests make no provider call at all: the link is only text inside a WhatsApp template.
  google_reviews: [],
  meta_capi: ["meta_capi"],
  // Phase 20i: the daily read of ad insights (GET only).
  meta_ads: ["meta_ads"],
  telehealth: ["daily"],
  esign: ["dropbox_sign"],
  // Phase 20e: the website chat calls nobody (the visitor's browser fetches replies).
  web_chat: [],
  instagram: ["instagram"],
  messenger: ["messenger"],
  google_calendar: ["google_calendar"],
  // Inbound only: the mail service posts to Pulse; Pulse never calls it.
  finance_mailbox: [],
  // Signing is local (the stored certificate, node:crypto); there is no provider and no call to record.
  document_seal: [],
  // Inbound only: the connector on the Tally PC calls Pulse; its calls are recorded under this name.
  tally_bridge: ["tally_bridge"],
  // Phase 20h: MM Lite sends go through the WhatsApp client with the channel token (messages carry their own status), not
  // through the integration client, so there is nothing in integration_calls to count.
  wa_mm_lite: [],
  // OQ-182: template sends and the key check through lib/integrations/sanoflow/client.ts.
  sanoflow: ["sanoflow"],
};
