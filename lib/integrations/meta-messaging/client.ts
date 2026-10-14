import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";

import { META_MESSAGING_HOST, type MessagingPlatform } from "./config";

/**
 * Send API adapter for Instagram and Messenger (Messenger Platform), built on the shared integration client. From Meta's
 * documentation as the author knows it, NOT verified against a live Page or Instagram account (docs/27_PHASE_20E_CHANNELS_NOTES.md):
 *
 *   POST https://graph.facebook.com/{version}/{page id}/messages        Authorization: Bearer {page access token}
 *     {"recipient":{"id":"<PSID or IGSID>"},"messaging_type":"RESPONSE","message":{"text":"..."}}
 *   200 {"recipient_id":"...","message_id":"m_..."}
 *   4xx {"error":{"message":"...","type":"OAuthException","code":10,"error_subcode":2018278,"fbtrace_id":"..."}}
 *
 * The send has no idempotency key, so it is retried only after a 429 (Meta did not take it). After a timeout or 5xx nobody knows
 * whether the person got it: the result is `ambiguous` and the caller must not send it again on its own.
 */
export type MessagingSendResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      code: string;
      /** Worth trying later (throttled before Meta accepted anything). */
      retryable: boolean;
      /** Meta may have delivered it. */
      ambiguous: boolean;
      /** Outside the 24-hour messaging window. */
      windowClosed: boolean;
      auth: boolean;
    };

export interface MessagingClient {
  readonly platform: MessagingPlatform;
  sendText(recipientId: string, text: string): Promise<MessagingSendResult>;
  verify(): Promise<{ ok: boolean; code?: string }>;
}

export type MessagingClientOptions = {
  platform: MessagingPlatform;
  pageId: string;
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

/** Graph error codes for bad or expired credentials or missing permissions. */
const AUTH_CODES = new Set([102, 190, 200, 10, 230, 299]);
/** Graph "slow down" codes. */
const THROTTLE_CODES = new Set([4, 17, 32, 613]);
/** Sent outside the allowed window (code 10 / subcode 2018278, or 2018108 on some API versions). */
const WINDOW_SUBCODES = new Set([2018278, 2018108]);

function graphError(res: HttpResult): { code: number | null; subcode: number | null } {
  const e = (res.json as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
  return {
    code: typeof e?.code === "number" ? e.code : null,
    subcode: typeof e?.error_subcode === "number" ? e.error_subcode : null,
  };
}

export function createMessagingClient(o: MessagingClientOptions): MessagingClient {
  const client = createIntegrationClient({
    provider: o.platform,
    allowedHosts: [META_MESSAGING_HOST],
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
  const base = `https://${META_MESSAGING_HOST}/${encodeURIComponent(o.graphVersion)}/${encodeURIComponent(o.pageId)}`;
  const authHeader = { Authorization: `Bearer ${o.accessToken}` };

  return {
    platform: o.platform,

    async sendText(recipientId, text) {
      if (!/^\d{1,40}$/.test(recipientId))
        return {
          ok: false,
          code: "bad_recipient",
          retryable: false,
          ambiguous: false,
          windowClosed: false,
          auth: false,
        };
      let res: HttpResult;
      try {
        res = await client.request({
          operation: `${o.platform}.send`,
          method: "POST",
          url: `${base}/messages`,
          headers: {
            ...authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: "RESPONSE",
            message: { text },
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
            windowClosed: false,
            auth: false,
          };
        throw err;
      }
      if (res.ok) {
        const id = (res.json as { message_id?: unknown } | null)?.message_id;
        if (typeof id === "string" && id && id.length <= 300) return { ok: true, messageId: id };
        return {
          ok: false,
          code: "no_message_id",
          retryable: false,
          ambiguous: true,
          windowClosed: false,
          auth: false,
        };
      }
      const e = graphError(res);
      const windowClosed = e.subcode !== null && WINDOW_SUBCODES.has(e.subcode);
      const auth =
        !windowClosed &&
        (res.status === 401 || res.status === 403 || (e.code !== null && AUTH_CODES.has(e.code)));
      return {
        ok: false,
        code:
          e.code !== null
            ? `graph_${e.code}${e.subcode ? `_${e.subcode}` : ""}`
            : `http_${res.status}`,
        retryable: e.code !== null && THROTTLE_CODES.has(e.code),
        ambiguous: false,
        windowClosed,
        auth,
      };
    },

    async verify() {
      try {
        const res = await client.request({
          operation: `${o.platform}.verify`,
          method: "GET",
          url: `${base}?fields=id`,
          headers: { ...authHeader, Accept: "application/json" },
        });
        if (res.ok) return { ok: true };
        const e = graphError(res);
        return {
          ok: false,
          code:
            res.status === 401 || res.status === 403 || (e.code !== null && AUTH_CODES.has(e.code))
              ? "auth"
              : e.code !== null
                ? `graph_${e.code}`
                : `http_${res.status}`,
        };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}

/** Staff-facing sentence for a failed send (no ids, no provider text). */
export function sendFailureText(
  platform: MessagingPlatform,
  r: Exclude<MessagingSendResult, { ok: true }>,
): string {
  const name = platform === "instagram" ? "Instagram" : "Messenger";
  if (r.windowClosed)
    return `${name} only allows a reply within 24 hours of the person's last message.`;
  if (r.ambiguous)
    return `${name} did not confirm this message. Check the conversation in ${name} before sending it again.`;
  if (r.auth)
    return `${name} refused the stored access token. An administrator must update it in Settings, Integrations.`;
  if (r.code === "graph_551") return `This person cannot receive messages right now.`;
  if (r.code === "breaker_open")
    return `${name} is failing at the moment; Pulse paused sending for a few minutes.`;
  return `${name} did not accept the message.`;
}
