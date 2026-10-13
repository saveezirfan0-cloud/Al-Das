import "server-only";

import { decryptJson, encryptJson } from "@/lib/crypto";
import {
  allFields,
  integrationDef,
  providerDef,
  type IntegrationKind,
} from "@/lib/integrations/catalog";
import type { BreakerStore, CallSink } from "@/lib/integrations/client";
import { CLOSED } from "@/lib/integrations/breaker";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { AccountView, Config, Secrets } from "@/lib/integrations/types";
import type { Tables } from "@/lib/supabase/types";

/**
 * Credentials and on/off state of every integration, one row per (org, kind) in integration_accounts.
 * The row is read and written ONLY by server code after can() (the table has no policies). Secrets live in `config_enc`
 * (AES-256-GCM); nothing here ever returns them to a caller that does not need to send them to the provider.
 */

export type AccountRow = Tables<"integration_accounts">;
export type { AccountView, Config, Secrets } from "@/lib/integrations/types";

export async function loadAccount(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
): Promise<AccountRow | null> {
  const { data } = await admin
    .from("integration_accounts")
    .select("*")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .maybeSingle();
  return data;
}

export async function loadAccountById(
  admin: AdminClient,
  id: string,
  kind: IntegrationKind,
): Promise<AccountRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { data } = await admin
    .from("integration_accounts")
    .select("*")
    .eq("id", id)
    .eq("kind", kind)
    .maybeSingle();
  return data;
}

/** The decrypted secret fields, or {} when none are stored or the ciphertext cannot be read. */
export function readSecrets(row: Pick<AccountRow, "config_enc"> | null): Secrets {
  if (!row) return {};
  try {
    const parsed = decryptJson<unknown>(row.config_enc);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Secrets = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function readConfig(row: Pick<AccountRow, "config"> | null): Config {
  const raw = row?.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Config = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
}

export function toView(kind: IntegrationKind, row: AccountRow | null): AccountView {
  const config = readConfig(row);
  const provider =
    typeof config.provider === "string" && providerDef(kind, config.provider)
      ? config.provider
      : integrationDef(kind).providers.length === 1
        ? integrationDef(kind).providers[0].id
        : null;
  const secrets = readSecrets(row);
  const secretsStored: Record<string, boolean> = {};
  for (const f of allFields(kind, provider)) if (f.secret) secretsStored[f.key] = !!secrets[f.key];
  return {
    kind,
    exists: !!row,
    provider,
    enabled: row?.enabled ?? false,
    status: row?.status ?? "disabled",
    config,
    secretsStored,
    lastOkAt: row?.last_ok_at ?? null,
    lastErrorAt: row?.last_error_at ?? null,
    lastError: row?.last_error ?? null,
    breakerOpenUntil: row?.breaker_open_until ?? null,
    consecutiveFailures: row?.consecutive_failures ?? 0,
    enabledAt: row?.enabled_at ?? null,
  };
}

export async function loadView(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
): Promise<AccountView> {
  return toView(kind, await loadAccount(admin, orgId, kind));
}

/**
 * Saves a settings form. Secret fields left blank keep their stored value; changing the provider drops the old provider's
 * secrets. Does not switch anything on or off.
 */
export async function saveSettings(
  admin: AdminClient,
  a: {
    orgId: string;
    kind: IntegrationKind;
    provider: string | null;
    secrets: Secrets;
    config: Config;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await loadAccount(admin, a.orgId, a.kind);
  const before = toView(a.kind, existing);
  const sameProvider = before.provider === a.provider;
  const kept = sameProvider ? readSecrets(existing) : {};
  const merged: Secrets = {};
  for (const f of allFields(a.kind, a.provider)) {
    if (!f.secret) continue;
    const next = a.secrets[f.key] ?? kept[f.key];
    if (next) merged[f.key] = next;
  }
  // Keep settings this form does not own (the payment template and its variable map); drop the previous provider's own fields.
  const providerOwned = new Set(
    integrationDef(a.kind).providers.flatMap((p) =>
      p.fields.filter((f) => !f.secret).map((f) => f.key),
    ),
  );
  const config: Config = {};
  for (const [k, v] of Object.entries(readConfig(existing)))
    if (!providerOwned.has(k)) config[k] = v;
  Object.assign(config, a.config);
  if (a.provider) config.provider = a.provider;
  const now = new Date().toISOString();
  const row = {
    org_id: a.orgId,
    kind: a.kind,
    config_enc: encryptJson(merged),
    config: config as never,
    credentials_set_at:
      Object.keys(a.secrets).length > 0 ? now : (existing?.credentials_set_at ?? null),
    ...(existing ? {} : { status: "disabled", enabled: false }),
  };
  const { error } = existing
    ? await admin
        .from("integration_accounts")
        .update(row)
        .eq("id", existing.id)
        .eq("org_id", a.orgId)
    : await admin.from("integration_accounts").insert(row);
  if (error) return { ok: false, error: "Could not save the settings." };
  return { ok: true };
}

/** Sets or clears single non-secret settings without touching the form's own fields (the payment template and its map). */
export async function patchConfig(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
  patch: Record<string, string | number | null>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await loadAccount(admin, orgId, kind);
  if (!existing) return { ok: false, error: "Save the settings first." };
  const config = readConfig(existing);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete config[k];
    else config[k] = v;
  }
  const { error } = await admin
    .from("integration_accounts")
    .update({ config: config as never })
    .eq("id", existing.id)
    .eq("org_id", orgId);
  return error ? { ok: false, error: "Could not save." } : { ok: true };
}

export async function setEnabled(
  admin: AdminClient,
  a: { orgId: string; kind: IntegrationKind; userId: string; enabled: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await loadAccount(admin, a.orgId, a.kind);
  if (!existing) {
    if (!a.enabled) return { ok: true };
    const created = await saveSettings(admin, {
      orgId: a.orgId,
      kind: a.kind,
      provider: null,
      secrets: {},
      config: {},
    });
    if (!created.ok) return created;
  }
  const { error } = await admin
    .from("integration_accounts")
    .update({
      enabled: a.enabled,
      status: a.enabled ? "active" : "disabled",
      enabled_at: a.enabled ? new Date().toISOString() : null,
      enabled_by: a.enabled ? a.userId : null,
      consecutive_failures: 0,
      breaker_open_until: null,
    })
    .eq("org_id", a.orgId)
    .eq("kind", a.kind);
  if (error) return { ok: false, error: "Could not change the switch." };
  return { ok: true };
}

/** True when the integration exists and its feature flag is on. Every integration code path asks this first. */
export async function isEnabled(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
): Promise<boolean> {
  const row = await loadAccount(admin, orgId, kind);
  return row?.enabled === true;
}

export async function recordOk(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
): Promise<void> {
  await admin
    .from("integration_accounts")
    .update({ last_ok_at: new Date().toISOString(), last_error: null, status: "active" })
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("enabled", true);
}

/** Remembers why the last call failed. The text is redacted and short; it never holds a body, token or phone number. */
export async function recordFailure(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
  reason: unknown,
): Promise<void> {
  await admin
    .from("integration_accounts")
    .update({
      last_error: redactText(reason, 200),
      last_error_at: new Date().toISOString(),
      status: "error",
    })
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("enabled", true);
}

/** The circuit breaker's state, kept in the account row (shared by every worker and surviving restarts). */
export function dbBreakerStore(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
): BreakerStore {
  return {
    async load() {
      const { data } = await admin
        .from("integration_accounts")
        .select("consecutive_failures, breaker_open_until")
        .eq("org_id", orgId)
        .eq("kind", kind)
        .maybeSingle();
      if (!data) return CLOSED;
      return {
        consecutiveFailures: data.consecutive_failures,
        openUntil: data.breaker_open_until ? new Date(data.breaker_open_until).getTime() : null,
      };
    },
    async save(state) {
      await admin
        .from("integration_accounts")
        .update({
          consecutive_failures: state.consecutiveFailures,
          breaker_open_until: state.openUntil ? new Date(state.openUntil).toISOString() : null,
        })
        .eq("org_id", orgId)
        .eq("kind", kind);
    },
  };
}

/** Writes each call to integration_calls (provider, operation, outcome, status code, latency; nothing else). */
export function dbCallSink(admin: AdminClient, orgId: string): CallSink {
  return {
    async record(c) {
      await admin.from("integration_calls").insert({
        org_id: orgId,
        provider: c.provider,
        operation: c.operation,
        outcome: c.outcome,
        http_status: c.httpStatus,
        duration_ms: c.durationMs,
        attempt: c.attempt,
      });
    },
  };
}

/** Daily counters (messages sent, parts, fetches). Never throws: a counter must not break the work it counts. */
export async function bumpUsage(
  admin: AdminClient,
  orgId: string,
  provider: string,
  metric: string,
  n = 1,
): Promise<void> {
  try {
    await admin.rpc("integration_usage_bump", {
      p_org: orgId,
      p_provider: provider,
      p_metric: metric,
      p_n: n,
    });
  } catch {
    /* counters are best effort */
  }
}
