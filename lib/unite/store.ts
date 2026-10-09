import "server-only";

import { decryptJson } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { DEFAULT_UNITE_BASE_URL, dbTokenStore } from "@/lib/finance/db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { createTokenManager, type Http, type UniteCredentials } from "@/lib/unite/auth";
import type { UniteAuth } from "@/lib/unite/sync-auth";
import {
  createUniteClient,
  type BreakerStore,
  type CallLog,
  type UniteClient,
} from "@/lib/unite/sync-client";
import { parseUniteConfig, type UniteConfig } from "@/lib/unite/config";

export type UniteAccount = { row: Tables<"integration_accounts">; config: UniteConfig };

export async function loadUniteAccount(
  admin: AdminClient,
  orgId: string,
): Promise<UniteAccount | null> {
  const { data } = await admin
    .from("integration_accounts")
    .select("*")
    .eq("org_id", orgId)
    .eq("kind", "unite")
    .maybeSingle();
  return data ? { row: data, config: parseUniteConfig(data.config) } : null;
}

/** The token manager's transport on top of a fetch (injectable so tests never touch the network). */
function httpFrom(fetchFn: typeof fetch): Http {
  return async ({ method, url, headers, body, timeoutMs }) => {
    const res = await fetchFn(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return { status: res.status, text: await res.text() };
  };
}

/**
 * True when the shared (Finance) credentials are stored and readable. They are entered once, under
 * Finance → Capture health, and used by both the Finance capture and this read-only sync.
 */
export function hasCredentials(row: Pick<Tables<"integration_accounts">, "config_enc">): boolean {
  try {
    const c = decryptJson<UniteCredentials>(row.config_enc);
    return !!c.authorize?.app_id && !!c.authorize?.app_key;
  } catch {
    return false;
  }
}

export const BREAKER_THRESHOLD = 5;
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

export function createDbBreakerStore(admin: AdminClient, orgId: string): BreakerStore {
  const match = { org_id: orgId, kind: "unite" } as const;
  return {
    async isOpen() {
      const { data } = await admin
        .from("integration_accounts")
        .select("breaker_open_until")
        .match(match)
        .maybeSingle();
      return !!data?.breaker_open_until && new Date(data.breaker_open_until) > new Date();
    },
    async recordSuccess() {
      await admin
        .from("integration_accounts")
        .update({ consecutive_failures: 0, breaker_open_until: null })
        .match(match)
        .gt("consecutive_failures", 0);
    },
    async recordFailure() {
      const { data } = await admin
        .from("integration_accounts")
        .select("consecutive_failures")
        .match(match)
        .maybeSingle();
      const failures = (data?.consecutive_failures ?? 0) + 1;
      const trip = failures >= BREAKER_THRESHOLD;
      await admin
        .from("integration_accounts")
        .update({
          consecutive_failures: failures,
          ...(trip
            ? { breaker_open_until: new Date(Date.now() + BREAKER_COOLDOWN_MS).toISOString() }
            : {}),
        })
        .match(match);
      return trip;
    },
  };
}

export function createCallLogger(admin: AdminClient, orgId: string) {
  return async (c: CallLog) => {
    // unite_api_calls is shared with the Finance capture, whose batch_id points at its own raw
    // batches, so the sync never sets it. The outcome goes in unite_status (no record data).
    await admin.from("unite_api_calls").insert({
      org_id: orgId,
      endpoint: c.endpoint,
      unite_status: c.outcome,
      http_status: c.httpStatus,
      duration_ms: c.durationMs,
    });
  };
}

/** A ready-to-use read-only client for an org, or an explanation of what is missing. */
export async function buildUniteClient(
  admin: AdminClient,
  orgId: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<
  | {
      ok: true;
      client: UniteClient;
      auth: UniteAuth;
      account: UniteAccount;
      breaker: BreakerStore;
    }
  | { ok: false; reason: "no_account" | "paused" | "no_credentials" }
> {
  const account = await loadUniteAccount(admin, orgId);
  if (!account) return { ok: false, reason: "no_account" };
  if (account.row.status !== "active") return { ok: false, reason: "paused" };
  if (!hasCredentials(account.row)) return { ok: false, reason: "no_credentials" };
  const baseUrl = account.config.base_url ?? serverEnv().UNITE_BASE_URL ?? DEFAULT_UNITE_BASE_URL;

  const fetchFn = opts.fetchFn ?? fetch;
  const breaker = createDbBreakerStore(admin, orgId);
  const log = createCallLogger(admin, orgId);
  const tokens = createTokenManager({
    store: dbTokenStore(admin, orgId),
    http: httpFrom(fetchFn),
    baseUrl,
    onCall: (c) =>
      void log({
        endpoint: c.endpoint,
        outcome: c.uniteStatus.startsWith("Success") ? "ok" : "auth_error",
        httpStatus: c.httpStatus,
        durationMs: c.durationMs,
      }),
  });
  const auth: UniteAuth = {
    getToken: (o) => (o?.force ? tokens.renewToken() : tokens.getToken()),
  };
  const client = createUniteClient({
    baseUrl,
    config: account.config,
    auth,
    breaker,
    fetchFn,
    onCall: log,
  });
  return { ok: true, client, auth, account, breaker };
}
