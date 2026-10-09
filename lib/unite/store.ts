import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import {
  createUniteAuth,
  type TokenState,
  type TokenStore,
  type UniteAuth,
} from "@/lib/unite/auth";
import {
  createUniteClient,
  type BreakerStore,
  type CallLog,
  type UniteClient,
} from "@/lib/unite/client";
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

/** App id / key: the encrypted per-org override, else the UNITE_APP_ID / UNITE_APP_KEY env vars. */
export function resolveCredentials(
  row: Pick<Tables<"integration_accounts">, "config_enc">,
): { appId: string; appKey: string } | null {
  if (row.config_enc) {
    try {
      const parsed = JSON.parse(decryptSecret(row.config_enc)) as {
        app_id?: string;
        app_key?: string;
      };
      if (parsed.app_id && parsed.app_key) return { appId: parsed.app_id, appKey: parsed.app_key };
    } catch {
      return null;
    }
  }
  const env = serverEnv();
  return env.UNITE_APP_ID && env.UNITE_APP_KEY
    ? { appId: env.UNITE_APP_ID, appKey: env.UNITE_APP_KEY }
    : null;
}

export function encryptCredentials(appId: string, appKey: string): string {
  return encryptSecret(JSON.stringify({ app_id: appId, app_key: appKey }));
}

export function createDbTokenStore(admin: AdminClient, orgId: string): TokenStore {
  return {
    async get() {
      const { data } = await admin
        .from("integration_accounts")
        .select("token_enc")
        .eq("org_id", orgId)
        .eq("kind", "unite")
        .maybeSingle();
      if (!data?.token_enc) return null;
      try {
        return JSON.parse(decryptSecret(data.token_enc)) as TokenState;
      } catch {
        return null;
      }
    },
    async set(token) {
      await admin
        .from("integration_accounts")
        .update({
          token_enc: encryptSecret(JSON.stringify(token)),
          token_expires_at: new Date(token.expiresAt).toISOString(),
          refresh_lock_until: null,
        })
        .eq("org_id", orgId)
        .eq("kind", "unite");
    },
    async claimRefresh() {
      const { data } = await admin.rpc("unite_claim_token_refresh", {
        p_org: orgId,
        p_ttl_seconds: 20,
      });
      return data === true;
    },
    async release() {
      await admin
        .from("integration_accounts")
        .update({ refresh_lock_until: null })
        .eq("org_id", orgId)
        .eq("kind", "unite");
    },
  };
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

export function createCallLogger(admin: AdminClient, orgId: string, batchId: string | null) {
  return async (c: CallLog) => {
    await admin.from("unite_api_calls").insert({
      org_id: orgId,
      endpoint: c.endpoint,
      outcome: c.outcome,
      http_status: c.httpStatus,
      duration_ms: c.durationMs,
      batch_id: batchId,
    });
  };
}

/** A ready-to-use read-only client for an org, or an explanation of what is missing. */
export async function buildUniteClient(
  admin: AdminClient,
  orgId: string,
  opts: { batchId?: string; fetchFn?: typeof fetch } = {},
): Promise<
  | {
      ok: true;
      client: UniteClient;
      auth: UniteAuth;
      account: UniteAccount;
      breaker: BreakerStore;
    }
  | { ok: false; reason: "no_account" | "paused" | "no_credentials" | "no_base_url" }
> {
  const account = await loadUniteAccount(admin, orgId);
  if (!account) return { ok: false, reason: "no_account" };
  if (account.row.status !== "active") return { ok: false, reason: "paused" };
  const creds = resolveCredentials(account.row);
  if (!creds) return { ok: false, reason: "no_credentials" };
  const baseUrl = account.config.base_url ?? serverEnv().UNITE_BASE_URL;
  if (!baseUrl) return { ok: false, reason: "no_base_url" };

  const fetchFn = opts.fetchFn ?? fetch;
  const breaker = createDbBreakerStore(admin, orgId);
  const auth = createUniteAuth({
    baseUrl,
    paths: account.config.paths,
    appId: creds.appId,
    appKey: creds.appKey,
    store: createDbTokenStore(admin, orgId),
    fetchFn,
  });
  const client = createUniteClient({
    baseUrl,
    config: account.config,
    auth,
    breaker,
    fetchFn,
    onCall: createCallLogger(admin, orgId, opts.batchId ?? null),
  });
  return { ok: true, client, auth, account, breaker };
}
