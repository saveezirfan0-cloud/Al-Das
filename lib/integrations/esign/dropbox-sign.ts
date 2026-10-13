import { DROPBOX_SIGN_HOST } from "@/lib/integrations/esign/config";
import type {
  CreateResult,
  CreateSignatureRequest,
  ESignProvider,
  FetchResult,
} from "@/lib/integrations/esign/types";
import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import { hmac, safeEqual } from "@/lib/integrations/webhook";

/**
 * A Dropbox Sign (HelloSign) shaped adapter. Request and response shapes follow the provider's documented API v3 as the author knows
 * it; they have NOT been checked against a live account (docs/19_PHASE_19B_NOTES.md). Tests use recorded fake responses.
 *
 *   Authorization: Basic base64("{api key}:")
 *   POST https://api.hellosign.com/v3/signature_request/send              (JSON)
 *     { test_mode: 0|1, title, subject, message, signers: [{email_address, name, order: 0}], file_urls: [url],
 *       use_text_tags: true, hide_text_tags: true, expires_at: <unix s>, metadata: { pulse_request: <our id> } }
 *   200 { signature_request: { signature_request_id, is_complete, signatures: [...] } }
 *   4xx { error: { error_msg, error_name } }
 *   POST /v3/signature_request/cancel/{id}                                 -> 200 (empty)
 *   GET  /v3/signature_request/files_as_data_uri/{id}                      -> 200 { data_uri: "data:application/pdf;base64,..." }
 *   GET  /v3/account                                                       -> 200 { account: {...} }   (Test connection)
 *
 * The send request is not idempotent: a repeat would e-mail the signer twice, so after a timeout or a 5xx the result is "ambiguous" and
 * nothing sends it again. The document is fetched by the provider from a short-lived link; the consent PDF is expected to carry the
 * provider's text tags (for example [sig|req|signer1]) that say where the signature goes.
 */
export type DropboxSignOptions = { apiKey: string } & Partial<
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

/** A signed PDF is at most 25 MB (the patient document limit); base64 adds a third. */
const MAX_FILE_RESPONSE = 36_000_000;

function errorName(res: HttpResult): string {
  const e = (res.json as { error?: { error_name?: unknown } } | null)?.error;
  return typeof e?.error_name === "string" ? e.error_name.slice(0, 40) : `http_${res.status}`;
}

export function createDropboxSignProvider(o: DropboxSignOptions): ESignProvider | null {
  if (!o.apiKey) return null;
  const base = `https://${DROPBOX_SIGN_HOST}/v3`;
  const auth = {
    Authorization: "Basic " + Buffer.from(`${o.apiKey}:`).toString("base64"),
    Accept: "application/json",
  };
  const make = (maxResponseBytes?: number) =>
    createIntegrationClient({
      provider: "dropbox_sign",
      allowedHosts: [DROPBOX_SIGN_HOST],
      fetchFn: o.fetchFn,
      now: o.now,
      sleep: o.sleep,
      rng: o.rng,
      sink: o.sink,
      breaker: o.breaker,
      breakerConfig: o.breakerConfig,
      timeoutMs: o.timeoutMs,
      maxRetries: o.maxRetries,
      maxResponseBytes,
    });
  const client = make();
  const fileClient = make(MAX_FILE_RESPONSE);

  return {
    id: "dropbox_sign",

    async createRequest(r: CreateSignatureRequest): Promise<CreateResult> {
      if (!r.signer.email)
        return { ok: false, code: "unsupported_signer", retryable: false, ambiguous: false };
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "esign.create",
          method: "POST",
          url: `${base}/signature_request/send`,
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            test_mode: r.testMode ? 1 : 0,
            title: r.title,
            subject: r.title,
            message: r.message,
            signers: [{ email_address: r.signer.email, name: r.signer.name, order: 0 }],
            file_urls: [r.fileUrl],
            use_text_tags: true,
            hide_text_tags: true,
            expires_at: Math.floor(r.expiresAt.getTime() / 1000),
            metadata: { pulse_request: r.clientRef },
          }),
          idempotent: false,
        });
      } catch (err) {
        if (err instanceof IntegrationError)
          return {
            ok: false,
            code: err.kind,
            retryable: err.retryable && !err.ambiguous,
            ambiguous: err.ambiguous,
          };
        throw err;
      }
      const id = (res.json as { signature_request?: { signature_request_id?: unknown } } | null)
        ?.signature_request?.signature_request_id;
      if (res.ok && typeof id === "string" && id)
        return { ok: true, providerRequestId: id.slice(0, 120) };
      if (res.ok) return { ok: false, code: "no_request_id", retryable: false, ambiguous: true };
      return {
        ok: false,
        code: res.status === 401 || res.status === 403 ? "auth" : errorName(res),
        retryable: false,
        ambiguous: false,
      };
    },

    async cancelRequest(providerRequestId) {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(providerRequestId)) return { ok: false, code: "bad_id" };
      try {
        const res = await client.request({
          operation: "esign.cancel",
          method: "POST",
          url: `${base}/signature_request/cancel/${encodeURIComponent(providerRequestId)}`,
          headers: auth,
          idempotent: true,
        });
        return res.ok ? { ok: true } : { ok: false, code: errorName(res) };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },

    async fetchSignedPdf(providerRequestId): Promise<FetchResult> {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(providerRequestId))
        return { ok: false, code: "bad_id", retryable: false };
      let res: HttpResult;
      try {
        res = await fileClient.request({
          operation: "esign.fetch_signed",
          method: "GET",
          url: `${base}/signature_request/files_as_data_uri/${encodeURIComponent(providerRequestId)}`,
          headers: auth,
          timeoutMs: 60_000,
        });
      } catch (err) {
        if (err instanceof IntegrationError)
          return { ok: false, code: err.kind, retryable: err.retryable };
        throw err;
      }
      if (!res.ok)
        return {
          ok: false,
          code: errorName(res),
          retryable: res.status === 404 || res.status === 409,
        };
      const uri = (res.json as { data_uri?: unknown } | null)?.data_uri;
      const m =
        typeof uri === "string"
          ? /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(uri)
          : null;
      if (!m) return { ok: false, code: "not_a_pdf", retryable: false };
      return { ok: true, bytes: new Uint8Array(Buffer.from(m[1], "base64")) };
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "esign.verify",
          method: "GET",
          url: `${base}/account`,
          headers: auth,
        });
        if (res.ok) return { ok: true };
        return {
          ok: false,
          code: res.status === 401 || res.status === 403 ? "auth" : errorName(res),
        };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------------------------------------------------------------

/** The event hash the provider signs a callback with: HMAC-SHA256 (key = API key) over event_time + event_type, as lower-case hex. */
export function eventHash(apiKey: string, eventTime: string, eventType: string): string {
  return hmac("sha256", apiKey, eventTime + eventType, "hex");
}

export function verifyEventHash(
  apiKey: string,
  e: { event_time?: unknown; event_type?: unknown; event_hash?: unknown },
): boolean {
  if (!apiKey) return false;
  if (typeof e.event_time !== "string" && typeof e.event_time !== "number") return false;
  if (typeof e.event_type !== "string" || typeof e.event_hash !== "string") return false;
  return safeEqual(
    eventHash(apiKey, String(e.event_time), e.event_type),
    e.event_hash.trim().toLowerCase(),
  );
}

export type CallbackEvent = {
  eventTime: string;
  eventType: string;
  eventHash: string;
  requestId: string | null;
  clientRef: string | null;
  isComplete: boolean;
};

/**
 * Reads a callback body: the provider posts multipart/form-data with the event as the "json" field (a JSON or urlencoded body with a
 * "json" field is read the same way). Returns null for anything that is not an event.
 */
export function parseCallback(raw: string, contentType: string | null): CallbackEvent | null {
  let jsonText: string | null = null;
  const ct = contentType ?? "";
  if (/multipart\/form-data/i.test(ct)) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(ct)?.[2];
    if (!boundary) return null;
    for (const part of raw.split(`--${boundary}`)) {
      if (!/name="json"/i.test(part)) continue;
      const i = part.indexOf("\r\n\r\n");
      const j = part.indexOf("\n\n");
      const start = i >= 0 ? i + 4 : j >= 0 ? j + 2 : -1;
      if (start < 0) continue;
      jsonText = part.slice(start).replace(/\r?\n$/, "");
      break;
    }
  } else if (/application\/x-www-form-urlencoded/i.test(ct)) {
    jsonText = new URLSearchParams(raw).get("json");
  } else {
    jsonText = raw;
  }
  if (!jsonText) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as {
    event?: { event_time?: unknown; event_type?: unknown; event_hash?: unknown };
    signature_request?: {
      signature_request_id?: unknown;
      is_complete?: unknown;
      metadata?: { pulse_request?: unknown } | null;
    };
  };
  const e = d.event;
  if (!e || (typeof e.event_time !== "string" && typeof e.event_time !== "number")) return null;
  if (typeof e.event_type !== "string" || typeof e.event_hash !== "string") return null;
  const sr = d.signature_request;
  return {
    eventTime: String(e.event_time),
    eventType: e.event_type.slice(0, 60),
    eventHash: e.event_hash,
    requestId:
      typeof sr?.signature_request_id === "string" ? sr.signature_request_id.slice(0, 120) : null,
    clientRef:
      typeof sr?.metadata?.pulse_request === "string"
        ? sr.metadata.pulse_request.slice(0, 60)
        : null,
    isComplete: sr?.is_complete === true,
  };
}
