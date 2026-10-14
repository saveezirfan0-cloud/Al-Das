import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import {
  gatewayUrlProblem,
  parseBodyTemplate,
  readIdField,
  renderGatewayBody,
  type HttpSmsConfig,
} from "@/lib/integrations/sms/http-config";
import type { SmsProvider, SmsSendInput, SmsSendResult } from "@/lib/integrations/sms/types";

/**
 * A generic HTTP SMS gateway (Phase 20h, the second SmsProvider next to twilio.ts). An administrator types the gateway's
 * https address, chooses bearer or basic sign-in, JSON or form encoding and a small body template ({to}, {from}, {text});
 * see http-config.ts. Every request goes through the shared client (createIntegrationClient): exactly the configured host,
 * https only, no redirects, a timeout and a response cap, back-off, the stored circuit breaker, and one integration_calls row
 * per attempt that never holds the address, the body or the number.
 *
 * The send is a POST without an idempotency key: the client retries it only after a 429 (not processed). After a timeout or a
 * 5xx it is `ambiguous` and the SMS job marks it failed (`unknown_delivery`) and never sends it again. A 2xx is accepted;
 * when a message id field is configured, a 2xx without it is treated as ambiguous too (some gateways answer 200 with an
 * error body). The generic gateway has no delivery receipts and no opt-out signal: the row stays "sent".
 *
 * Nothing here has been checked against a real gateway (docs/30_PHASE_20H_SMS_MMLITE_NOTES.md).
 */

export const HTTP_SMS_PROVIDER = "sms_http";

export type HttpSmsOptions = HttpSmsConfig & {
  /** Bearer token, or the password for basic sign-in. */
  secret: string;
  /** The registered sender ID, for {from}. */
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

function statusCode(res: HttpResult): string {
  return res.status === 401 || res.status === 403 ? "auth" : `http_${res.status}`;
}

/** Null when the settings cannot be used (the factory in provider.ts then reports "not configured"). */
export function createHttpSmsProvider(o: HttpSmsOptions): SmsProvider | null {
  if (!o.url || gatewayUrlProblem(o.url) || !o.secret) return null;
  if (o.auth === "basic" && !o.username) return null;
  const template = parseBodyTemplate(o.body);
  if (!template.ok) return null;
  const host = new URL(o.url).hostname.toLowerCase();
  const testUrl =
    o.testUrl && !gatewayUrlProblem(o.testUrl) && new URL(o.testUrl).hostname.toLowerCase() === host
      ? o.testUrl
      : null;

  const client = createIntegrationClient({
    provider: HTTP_SMS_PROVIDER,
    allowedHosts: [host],
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
  const authorization =
    o.auth === "basic"
      ? "Basic " + Buffer.from(`${o.username}:${o.secret}`).toString("base64")
      : `Bearer ${o.secret}`;

  return {
    id: "http",

    async send(input: SmsSendInput): Promise<SmsSendResult> {
      const { body, contentType } = renderGatewayBody(template.parts, o.encoding, {
        to: input.to,
        from: o.sender,
        text: input.body,
      });
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "sms.send",
          method: "POST",
          url: o.url,
          headers: {
            Authorization: authorization,
            "Content-Type": contentType,
            Accept: "application/json",
          },
          body,
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
      if (res.ok) {
        const id = o.idField ? readIdField(res.json, o.idField) : null;
        if (o.idField && !id)
          return {
            ok: false,
            code: "no_message_id",
            retryable: false,
            ambiguous: true,
            optOut: false,
          };
        return {
          ok: true,
          providerMessageId: id ?? `http:${input.clientRef}`.slice(0, 80),
          status: "sent",
          segments: null,
        };
      }
      return {
        ok: false,
        code: statusCode(res),
        retryable: false,
        ambiguous: false,
        optOut: false,
      };
    },

    async verify() {
      // Without a read-only check address there is no safe test: a POST to the send address would text someone.
      if (!testUrl) return { ok: false, code: "unsupported" };
      try {
        const res = await client.request({
          operation: "sms.verify",
          method: "GET",
          url: testUrl,
          headers: { Authorization: authorization, Accept: "application/json" },
        });
        return res.ok ? { ok: true } : { ok: false, code: statusCode(res) };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}
