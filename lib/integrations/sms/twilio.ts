import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import type { SmsProvider, SmsSendInput, SmsSendResult } from "@/lib/integrations/sms/types";
import { hmac, safeEqual } from "@/lib/integrations/webhook";

/**
 * A Twilio-style REST adapter (the first real SMS adapter). Request and response shapes follow Twilio's documented Messages API;
 * they have NOT been checked against a live account (see docs/18_PHASE_19A_NOTES.md). Tests use recorded fake responses.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json   (form-encoded, HTTP Basic sid:token)
 *     To, From | MessagingServiceSid, Body, StatusCallback
 *   201 {"sid":"SM…","status":"queued","num_segments":"1","error_code":null,…}
 *   4xx {"code":21610,"message":"…","more_info":"…","status":400}
 *
 * Delivery receipts: POST (form) to StatusCallback with MessageSid, MessageStatus, ErrorCode and the header
 * X-Twilio-Signature = base64(HMAC-SHA1(authToken, callbackUrl + each form field name+value, sorted by name)).
 */

export const TWILIO_HOST = "api.twilio.com";

export type TwilioOptions = {
  accountSid: string;
  authToken: string;
  /** An alphanumeric sender ID, a phone number, or a Messaging Service SID ("MG…"). */
  sender: string;
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

/** Twilio error numbers after which the person must not be texted again. */
const OPT_OUT_CODES = new Set(["21610"]);
/** Auth problems: our credentials, not the recipient. */
const AUTH_CODES = new Set(["20003", "20404"]);

function errorCode(res: HttpResult): string {
  const body = res.json as { code?: unknown } | null;
  if (body && (typeof body.code === "number" || typeof body.code === "string"))
    return String(body.code);
  return res.status === 401 || res.status === 403 ? "20003" : `http_${res.status}`;
}

export function createTwilioProvider(o: TwilioOptions): SmsProvider {
  const client = createIntegrationClient({
    provider: "twilio",
    allowedHosts: [TWILIO_HOST],
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
  const auth = "Basic " + Buffer.from(`${o.accountSid}:${o.authToken}`).toString("base64");
  const base = `https://${TWILIO_HOST}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;

  return {
    id: "twilio",

    async send(input: SmsSendInput): Promise<SmsSendResult> {
      const form = new URLSearchParams();
      form.set("To", input.to);
      if (/^MG[0-9a-f]{32}$/i.test(o.sender)) form.set("MessagingServiceSid", o.sender);
      else form.set("From", o.sender);
      form.set("Body", input.body);
      form.set("StatusCallback", input.statusCallbackUrl);
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "sms.send",
          method: "POST",
          url: `${base}/Messages.json`,
          headers: {
            Authorization: auth,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
          idempotent: false,
        });
      } catch (err) {
        if (err instanceof IntegrationError) {
          return {
            ok: false,
            code: err.kind,
            retryable: err.retryable && !err.ambiguous,
            ambiguous: err.ambiguous,
            optOut: false,
          };
        }
        throw err;
      }
      const body = res.json as { sid?: unknown; status?: unknown; num_segments?: unknown } | null;
      if (res.ok && body && typeof body.sid === "string") {
        const segments = Number(body.num_segments);
        return {
          ok: true,
          providerMessageId: body.sid,
          status: typeof body.status === "string" ? body.status : "queued",
          segments: Number.isFinite(segments) && segments > 0 ? Math.floor(segments) : null,
        };
      }
      const code = errorCode(res);
      return {
        ok: false,
        code,
        retryable: false,
        ambiguous: res.ok, // a 2xx without a message id: the provider may have accepted it
        optOut: OPT_OUT_CODES.has(code),
      };
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "sms.verify",
          method: "GET",
          url: `${base}.json`,
          headers: { Authorization: auth, Accept: "application/json" },
        });
        if (res.ok) return { ok: true };
        const code = errorCode(res);
        return { ok: false, code: AUTH_CODES.has(code) ? "auth" : code };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}

/** Twilio's request signature for a form POST (exported so tests and the verifier share one implementation). */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return hmac("sha1", authToken, data, "base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null | undefined,
): boolean {
  if (!header || !authToken) return false;
  return safeEqual(twilioSignature(authToken, url, params), header.trim());
}
