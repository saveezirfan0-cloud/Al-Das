import { CAPI_HOST } from "@/lib/integrations/capi/config";
import type { CapiPayload } from "@/lib/integrations/capi/event";
import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";

/**
 * Meta Conversions API adapter. Request and response shapes follow Meta's documentation for business messaging as the author knows
 * it; they have NOT been checked against a live dataset (docs/19_PHASE_19B_NOTES.md). Tests use recorded fake responses.
 *
 *   POST https://graph.facebook.com/{version}/{dataset id}/events      Authorization: Bearer {access token}
 *     body = CapiPayload (see event.ts)
 *   200 {"events_received":1,"messages":[],"fbtrace_id":"A..."}
 *   4xx {"error":{"message":"…","type":"OAuthException","code":190,"error_subcode":463,"fbtrace_id":"…"}}
 *
 * Re-sending an event with the same event_id is harmless (Meta de-duplicates on it), so the POST is marked idempotent and retried with
 * back-off after a timeout or 5xx.
 */
export type CapiSendResult =
  | { ok: true; eventsReceived: number }
  | { ok: false; code: string; retryable: boolean; auth: boolean };

export interface CapiClient {
  readonly id: "meta_capi";
  sendEvents(payload: CapiPayload): Promise<CapiSendResult>;
  verify(): Promise<{ ok: boolean; code?: string }>;
}

export type CapiClientOptions = {
  datasetId: string;
  accessToken: string;
  graphVersion: string;
} & Partial<
  Pick<
    ClientDeps,
    | "fetchFn"
    | "now"
    | "sleep"
    | "rng"
    | "sink"
    | "breaker"
    | "breakerConfig"
    | "timeoutMs"
    | "maxRetries"
  >
>;

/** Graph error codes that mean the credentials (or the dataset permission) are the problem, not the event. */
const AUTH_CODES = new Set([102, 190, 200, 10, 299]);
/** Graph "slow down" codes. */
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80004]);

function errorOf(res: HttpResult): { code: number | null; retryable: boolean; auth: boolean } {
  const e = (res.json as { error?: { code?: unknown } } | null)?.error;
  const code = typeof e?.code === "number" ? e.code : null;
  const auth = res.status === 401 || res.status === 403 || (code !== null && AUTH_CODES.has(code));
  return { code, auth, retryable: code !== null && THROTTLE_CODES.has(code) };
}

export function createCapiClient(o: CapiClientOptions): CapiClient {
  const client = createIntegrationClient({
    provider: "meta_capi",
    allowedHosts: [CAPI_HOST],
    fetchFn: o.fetchFn,
    now: o.now,
    sleep: o.sleep,
    rng: o.rng,
    sink: o.sink,
    breaker: o.breaker,
    breakerConfig: o.breakerConfig,
    timeoutMs: o.timeoutMs,
    maxRetries: o.maxRetries,
  });
  const base = `https://${CAPI_HOST}/${encodeURIComponent(o.graphVersion)}/${encodeURIComponent(o.datasetId)}`;
  const auth = { Authorization: `Bearer ${o.accessToken}` };

  return {
    id: "meta_capi",

    async sendEvents(payload) {
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "capi.events",
          method: "POST",
          url: `${base}/events`,
          headers: { ...auth, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          idempotent: true,
        });
      } catch (err) {
        if (err instanceof IntegrationError)
          return { ok: false, code: err.kind, retryable: err.retryable, auth: false };
        throw err;
      }
      if (res.ok) {
        const n = Number((res.json as { events_received?: unknown } | null)?.events_received);
        if (Number.isFinite(n) && n >= 1) return { ok: true, eventsReceived: n };
        return { ok: false, code: "not_received", retryable: false, auth: false };
      }
      const e = errorOf(res);
      return {
        ok: false,
        code: e.code !== null ? `graph_${e.code}` : `http_${res.status}`,
        retryable: e.retryable,
        auth: e.auth,
      };
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "capi.verify",
          method: "GET",
          url: `${base}?fields=id`,
          headers: { ...auth, Accept: "application/json" },
        });
        if (res.ok) return { ok: true };
        const e = errorOf(res);
        return {
          ok: false,
          code: e.auth ? "auth" : e.code !== null ? `graph_${e.code}` : `http_${res.status}`,
        };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}
