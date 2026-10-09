import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { decryptJson, encryptJson } from "@/lib/crypto";
import { runCapture, type CaptureDeps, type CaptureResult } from "@/lib/finance/capture";
import { processBatch, type ProcessDeps } from "@/lib/finance/process-batch";
import { createTokenManager, type TokenStore, type UniteCredentials } from "@/lib/unite/auth";
import { createUniteClient, fetchHttp } from "@/lib/unite/client";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/** Supabase-backed dependencies for the pure capture / process modules. */

export const DEFAULT_UNITE_BASE_URL = "https://ucexternalapiprod.uniteuae.care/gateway/";

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export function dbProcessDeps(admin: AdminClient): ProcessDeps {
  return {
    loadBatch: async (batchId) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id, org_id, payload, record_count")
        .eq("id", batchId)
        .maybeSingle();
      if (error) throw new Error(`load batch: ${error.message}`);
      return data
        ? { id: data.id, orgId: data.org_id, payload: data.payload, recordCount: data.record_count }
        : null;
    },
    apply: async (orgId, batchId, invoices, duplicates) => {
      const counts = must(
        await admin.rpc("fin_apply_invoices", {
          p_org_id: orgId,
          p_batch_id: batchId,
          p_invoices: invoices as unknown as Json,
          p_duplicates: duplicates,
        }),
        "fin_apply_invoices",
      );
      return (counts ?? {}) as Record<string, number>;
    },
    markFailed: async (batchId, error) => {
      must(
        await admin.rpc("fin_batch_mark_failed", { p_batch_id: batchId, p_error: error }),
        "fin_batch_mark_failed",
      );
    },
  };
}

/** Encrypted Unite credentials + token cache in integration_accounts (kind 'unite'). */
export function dbTokenStore(admin: AdminClient, orgId: string): TokenStore {
  return {
    load: async () => {
      const { data, error } = await admin
        .from("integration_accounts")
        .select("config_enc, status")
        .eq("org_id", orgId)
        .eq("kind", "unite")
        .maybeSingle();
      if (error) throw new Error(`load integration: ${error.message}`);
      if (!data || data.status !== "active") return null;
      return decryptJson<UniteCredentials>(data.config_enc);
    },
    save: async (creds) => {
      const expires =
        creds.issued_at !== undefined
          ? new Date(creds.issued_at + (creds.ttl_seconds ?? 240) * 1000).toISOString()
          : null;
      const { error } = await admin
        .from("integration_accounts")
        .update({ config_enc: encryptJson(creds), token_expires_at: expires, last_error: null })
        .eq("org_id", orgId)
        .eq("kind", "unite");
      if (error) throw new Error(`save integration: ${error.message}`);
    },
  };
}

export async function buildCaptureDeps(
  admin: AdminClient,
  orgId: string,
  budgetMs: number,
): Promise<CaptureDeps> {
  const { data: org } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  const timezone = org?.timezone ?? "Asia/Dubai";
  const baseUrl = process.env.UNITE_BASE_URL || DEFAULT_UNITE_BASE_URL;

  const logCall = (
    endpoint: string,
    httpStatus: number | null,
    uniteStatus: string,
    durationMs: number,
  ) => {
    void admin
      .from("unite_api_calls")
      .insert({
        org_id: orgId,
        endpoint,
        http_status: httpStatus,
        unite_status: uniteStatus,
        duration_ms: durationMs,
      })
      .then(({ error }) => {
        if (error) console.error("[finance] unite_api_calls insert failed", { code: error.code });
      });
  };

  const tokens = createTokenManager({
    store: dbTokenStore(admin, orgId),
    http: fetchHttp,
    baseUrl,
    onCall: (c) => logCall(c.endpoint, c.httpStatus, c.uniteStatus, c.durationMs),
  });
  const client = createUniteClient({
    tokens,
    http: fetchHttp,
    baseUrl,
    onCall: (c) => logCall(c.endpoint, c.httpStatus, c.uniteStatus, c.durationMs),
  });
  const processDeps = dbProcessDeps(admin);

  return {
    budgetMs,
    loadSettings: async () => {
      const { data, error } = await admin
        .from("fin_capture_settings")
        .select("*")
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(`load settings: ${error.message}`);
      return data
        ? {
            enabled: data.enabled,
            batchSize: data.batch_size,
            windowFrom: data.window_from,
            maxBatchesPerRun: data.max_batches_per_run,
          }
        : null;
    },
    tryLease: async (holder, ttl) =>
      Boolean(
        must(
          await admin.rpc("fin_capture_try_lease", {
            p_org_id: orgId,
            p_holder: holder,
            p_ttl_seconds: ttl,
          }),
          "lease",
        ),
      ),
    releaseLease: async (holder) => {
      must(
        await admin.rpc("fin_capture_release_lease", { p_org_id: orgId, p_holder: holder }),
        "release lease",
      );
    },
    today: () => formatInTimeZone(new Date(), timezone, "yyyy-MM-dd"),
    financeDetails: (req) => client.financeDetails(req),
    insertRaw: async (row) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .insert({ ...row, org_id: orgId, payload: row.payload as Json })
        .select("id")
        .single();
      if (error) throw new Error(`insert raw batch: ${error.message}`);
      return data.id;
    },
    pendingBatchIds: async () => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id")
        .eq("org_id", orgId)
        .neq("process_status", "processed")
        .order("requested_at", { ascending: true })
        .limit(50);
      if (error) throw new Error(`load pending batches: ${error.message}`);
      return (data ?? []).map((b) => b.id);
    },
    processBatch: (batchId) => processBatch(processDeps, batchId),
    raiseCritical: async (reason, detail) => {
      must(
        await admin.rpc("fin_open_exception", {
          p_org_id: orgId,
          p_rule_code: "E09",
          p_entity_type: "batch",
          p_entity_key: `capture:${reason}`,
          p_detail: { reason, ...detail } as Json,
        }),
        "fin_open_exception",
      );
    },
    markBatchFailed: processDeps.markFailed,
    log: (msg, meta) => console.warn(`[finance] ${msg}`, meta ?? ""),
  };
}

export async function runCaptureForOrg(
  admin: AdminClient,
  orgId: string,
  budgetMs: number,
): Promise<CaptureResult> {
  return runCapture(await buildCaptureDeps(admin, orgId, budgetMs));
}
