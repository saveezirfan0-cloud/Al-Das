import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";

import { SANOFLOW_CONTACTS_URL, SANOFLOW_HOST, SANOFLOW_SEND_TEMPLATE_URL } from "./config";

/**
 * The Sanoflow API adapter (OQ-182), built on the shared integration client: only developers.sanoflow.io, https, no redirects,
 * a timeout, back-off, the stored circuit breaker and one integration_calls row per attempt (never the key, number or body).
 *
 * The send is a POST without an idempotency key, so it is retried only after a 429. After a timeout or a 5xx nobody knows
 * whether WhatsApp delivered it: the result is `ambiguous` and the caller marks the message failed and never sends it again.
 *
 * Judging the answer (Make never reads it, so the shape is unconfirmed): a 2xx is accepted unless its JSON says otherwise
 * (`status: false`, `success: false`, `status: "error"` / `"failed"`, or an `error` object). A 2xx that says it failed is a
 * definite failure (Sanoflow answered), not ambiguous. A message id is read from the usual places when present.
 */
export const SANOFLOW_PROVIDER = "sanoflow";

export type SanoflowSendResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      code: string;
      retryable: boolean;
      ambiguous: boolean;
      auth: boolean;
      /** The answer carried WhatsApp's 131050 (the person stopped marketing messages). */
      stopMarketing: boolean;
    };

export interface SanoflowClient {
  sendTemplate(input: {
    templateId: number;
    phone: string;
    values: readonly string[];
  }): Promise<SanoflowSendResult>;
  verify(): Promise<{ ok: boolean; code?: string }>;
}

export type SanoflowClientOptions = { accessToken: string } & Partial<
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

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** True when a 2xx body plainly reports a failure. */
export function answerSaysFailed(json: unknown): boolean {
  const o = asObject(json);
  if (!o) return false;
  if (o.status === false || o.success === false) return true;
  if (typeof o.status === "string" && /^(error|fail(ed|ure)?)$/i.test(o.status)) return true;
  if (o.error && (typeof o.error === "string" || asObject(o.error))) return true;
  return false;
}

/** A message id from the answer (`message_id`, `id`, `wamid`, at the top level or under `data`), or null. */
export function readMessageId(json: unknown): string | null {
  for (const o of [asObject(json), asObject(asObject(json)?.data)]) {
    if (!o) continue;
    for (const k of ["message_id", "messageId", "wamid", "id"]) {
      const v = o[k];
      if ((typeof v === "string" && v.trim()) || typeof v === "number")
        return String(v).trim().slice(0, 120);
    }
  }
  return null;
}

/** True when any `code` / `error_code` in the answer is WhatsApp's 131050. */
export function answerStopsMarketing(json: unknown): boolean {
  const seen = (o: Json | null): boolean =>
    !!o && [o.code, o.error_code, o.errorCode].some((c) => Number(c) === 131050);
  const top = asObject(json);
  return seen(top) || seen(asObject(top?.error)) || seen(asObject(top?.data));
}

function failure(res: HttpResult): SanoflowSendResult {
  const auth = res.status === 401 || res.status === 403;
  return {
    ok: false,
    code: auth ? "auth" : res.ok ? "rejected" : `http_${res.status}`,
    retryable: false,
    ambiguous: false,
    auth,
    stopMarketing: answerStopsMarketing(res.json),
  };
}

export function createSanoflowClient(o: SanoflowClientOptions): SanoflowClient | null {
  if (!o.accessToken) return null;
  const client = createIntegrationClient({
    provider: SANOFLOW_PROVIDER,
    allowedHosts: [SANOFLOW_HOST],
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
  const headers = {
    "access-token": o.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  return {
    async sendTemplate(input) {
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "sanoflow.send_template",
          method: "POST",
          url: SANOFLOW_SEND_TEMPLATE_URL,
          headers,
          body: JSON.stringify({
            template_id: input.templateId,
            phone: input.phone,
            mapper_value: [...input.values],
          }),
          idempotent: false,
        });
      } catch (err) {
        if (err instanceof IntegrationError) {
          return {
            ok: false,
            code: err.kind,
            retryable: err.retryable && !err.ambiguous,
            ambiguous: err.ambiguous,
            auth: false,
            stopMarketing: false,
          };
        }
        throw err;
      }
      if (!res.ok || answerSaysFailed(res.json)) return failure(res);
      return { ok: true, providerMessageId: readMessageId(res.json) };
    },

    // Checks the key only: asks for contact id 0, which does not exist, so no patient's details come back. The body is
    // never read.
    async verify() {
      try {
        const res = await client.request({
          operation: "sanoflow.verify",
          method: "GET",
          url: `${SANOFLOW_CONTACTS_URL}?contact_id=0`,
          headers,
        });
        if (res.status === 401 || res.status === 403) return { ok: false, code: "auth" };
        return res.ok ? { ok: true } : { ok: false, code: `http_${res.status}` };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}
