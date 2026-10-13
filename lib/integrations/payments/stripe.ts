import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentEvent,
  PaymentProvider,
} from "@/lib/integrations/payments/types";
import { hmac, safeEqual, withinReplayWindow } from "@/lib/integrations/webhook";

/**
 * Stripe Checkout Sessions (hosted payment page). Shapes follow Stripe's documented REST API; they have NOT been checked against a
 * live or test account (see docs/18_PHASE_19A_NOTES.md). Tests use recorded fake responses.
 *
 *   POST https://api.stripe.com/v1/checkout/sessions           form-encoded, Bearer secret key, Idempotency-Key = our request id
 *     mode=payment, client_reference_id, expires_at (unix, 30 min to 24 h ahead), success_url, cancel_url,
 *     line_items[0][quantity]=1, line_items[0][price_data][currency|unit_amount|product_data][name]
 *   200 {"id":"cs_…","url":"https://checkout.stripe.com/c/pay/…","expires_at":…,"status":"open","amount_total":…}
 *   POST /v1/checkout/sessions/{id}/expire
 *   Webhook: header Stripe-Signature "t=<unix>,v1=<hex>" = HMAC-SHA256(endpoint secret, "<t>.<raw body>"), 5 minute tolerance.
 *     checkout.session.completed | .async_payment_succeeded | .async_payment_failed | .expired
 */

export const STRIPE_HOST = "api.stripe.com";
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export type StripeOptions = { secretKey: string } & Partial<
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

function stripeErrorCode(res: HttpResult): string {
  const body = res.json as { error?: { code?: unknown; type?: unknown } } | null;
  const code = body?.error?.code ?? body?.error?.type;
  if (typeof code === "string" && code) return code.slice(0, 60);
  return res.status === 401 || res.status === 403 ? "auth" : `http_${res.status}`;
}

export function createStripeProvider(o: StripeOptions): PaymentProvider {
  const client = createIntegrationClient({
    provider: "stripe",
    allowedHosts: [STRIPE_HOST],
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
  const auth = { Authorization: `Bearer ${o.secretKey}`, Accept: "application/json" };

  return {
    id: "stripe",

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const form = new URLSearchParams();
      form.set("mode", "payment");
      form.set("client_reference_id", input.requestId);
      form.set("expires_at", String(Math.floor(input.expiresAt.getTime() / 1000)));
      form.set("success_url", input.returnUrl);
      form.set("cancel_url", input.returnUrl);
      form.set("line_items[0][quantity]", "1");
      form.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
      form.set("line_items[0][price_data][unit_amount]", String(input.amountMinor));
      form.set("line_items[0][price_data][product_data][name]", input.description);
      form.set("metadata[request_id]", input.requestId);
      form.set("payment_intent_data[metadata][request_id]", input.requestId);
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "payments.create",
          method: "POST",
          url: `https://${STRIPE_HOST}/v1/checkout/sessions`,
          headers: {
            ...auth,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": `pulse-pay-${input.requestId}`,
          },
          body: form.toString(),
          idempotent: true, // the Idempotency-Key makes a repeat harmless
        });
      } catch (err) {
        if (err instanceof IntegrationError)
          return { ok: false, code: err.kind, retryable: err.retryable, ambiguous: err.ambiguous };
        throw err;
      }
      const body = res.json as { id?: unknown; url?: unknown; expires_at?: unknown } | null;
      if (res.ok && body && typeof body.id === "string" && typeof body.url === "string") {
        const exp = Number(body.expires_at);
        return {
          ok: true,
          ref: body.id,
          url: body.url,
          expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null,
        };
      }
      return { ok: false, code: stripeErrorCode(res), retryable: false, ambiguous: false };
    },

    async expire(ref: string): Promise<boolean> {
      try {
        const res = await client.request({
          operation: "payments.expire",
          method: "POST",
          url: `https://${STRIPE_HOST}/v1/checkout/sessions/${encodeURIComponent(ref)}/expire`,
          headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
          idempotent: true,
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "payments.verify",
          method: "GET",
          url: `https://${STRIPE_HOST}/v1/balance`,
          headers: auth,
        });
        return res.ok ? { ok: true } : { ok: false, code: stripeErrorCode(res) };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}

export function parseStripeSignatureHeader(
  header: string | null | undefined,
): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") t = Number(v);
    else if (k?.trim() === "v1" && v) v1.push(v.trim());
  }
  return Number.isFinite(t) && v1.length > 0 ? { t, v1 } : null;
}

/** Stripe's signature scheme with a replay window. */
export function verifyStripeWebhook(
  secret: string,
  raw: string,
  header: string | null | undefined,
  nowMs: number,
): boolean {
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed || !secret) return false;
  if (!withinReplayWindow(parsed.t, nowMs, STRIPE_SIGNATURE_TOLERANCE_SEC)) return false;
  const expected = hmac("sha256", secret, `${parsed.t}.${raw}`, "hex");
  return parsed.v1.some((candidate) => safeEqual(expected, candidate));
}

/** Test helper and documentation of the scheme: the header a genuine delivery would carry. */
export function stripeSignatureHeader(secret: string, raw: string, tSec: number): string {
  return `t=${tSec},v1=${hmac("sha256", secret, `${tSec}.${raw}`, "hex")}`;
}

type StripeSession = {
  id?: unknown;
  client_reference_id?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_status?: unknown;
  metadata?: { request_id?: unknown } | null;
};

export function parseStripeEvents(raw: string): PaymentEvent[] {
  const evt = JSON.parse(raw) as {
    id?: unknown;
    type?: unknown;
    data?: { object?: StripeSession };
  };
  if (typeof evt.id !== "string" || typeof evt.type !== "string")
    throw new Error("not a Stripe event");
  const s = evt.data?.object ?? {};
  const providerRef = typeof s.id === "string" ? s.id : null;
  const requestId =
    typeof s.client_reference_id === "string"
      ? s.client_reference_id
      : typeof s.metadata?.request_id === "string"
        ? s.metadata.request_id
        : null;
  const amountMinor =
    typeof s.amount_total === "number" && Number.isSafeInteger(s.amount_total)
      ? s.amount_total
      : null;
  const currency = typeof s.currency === "string" ? s.currency.toUpperCase() : null;
  const base = {
    key: evt.id,
    providerRef,
    requestId,
    amountMinor,
    currency,
    code: null as string | null,
  };
  switch (evt.type) {
    case "checkout.session.completed":
      // "unpaid" means a delayed payment method (bank transfer): the result arrives later as async_payment_*.
      return [{ ...base, type: s.payment_status === "paid" ? "paid" : "ignored" }];
    case "checkout.session.async_payment_succeeded":
      return [{ ...base, type: "paid" }];
    case "checkout.session.async_payment_failed":
      return [{ ...base, type: "failed", code: "async_payment_failed" }];
    case "checkout.session.expired":
      return [{ ...base, type: "expired" }];
    default:
      return [{ ...base, type: "ignored" }];
  }
}
