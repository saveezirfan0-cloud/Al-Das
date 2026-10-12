import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import { majorToMinor } from "@/lib/integrations/payments/money";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentEvent,
  PaymentProvider,
} from "@/lib/integrations/payments/types";
import { hmac, safeEqual } from "@/lib/integrations/webhook";

/**
 * A PayTabs-style UAE gateway (hosted payment page). Shapes follow PayTabs' documented "Create a payment page" API; they have NOT
 * been checked against a live or sandbox account (see docs/18_PHASE_19A_NOTES.md). Tests use recorded fake responses.
 *
 *   POST https://<region host>/payment/request     JSON, header `authorization: <server key>`
 *     { profile_id, tran_type:"sale", tran_class:"ecom", cart_id (our request id), cart_currency, cart_amount (decimal),
 *       cart_description, callback (our webhook URL), return (after payment), hide_shipping:true }
 *   200 { tran_ref, cart_id, redirect_url, … }
 *   Callback (server to server): POST JSON with header `signature` = hex HMAC-SHA256(server key, raw body)
 *     { tran_ref, cart_id, cart_currency, cart_amount, tran_currency, tran_total,
 *       payment_result: { response_status: A authorised | D declined | E error | V voided | H hold | P pending | X expired } }
 *
 * No customer details are sent: the payer types them on the hosted page.
 */

/** Hosts a stored region may name (the catalogue's list). Anything else is refused by the client's host allow-list. */
export const PAYTABS_HOSTS = [
  "secure.paytabs.com",
  "secure-oman.paytabs.com",
  "secure-egypt.paytabs.com",
  "secure-jordan.paytabs.com",
  "secure.paytabs.sa",
  "secure-global.paytabs.com",
] as const;

export type PaytabsOptions = { serverKey: string; profileId: string; regionHost: string } & Partial<
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

function paytabsErrorCode(res: HttpResult): string {
  const body = res.json as { code?: unknown } | null;
  if (body && (typeof body.code === "number" || typeof body.code === "string"))
    return String(body.code).slice(0, 60);
  return res.status === 401 || res.status === 403 ? "auth" : `http_${res.status}`;
}

export function createPaytabsProvider(o: PaytabsOptions): PaymentProvider {
  const client = createIntegrationClient({
    provider: "paytabs",
    allowedHosts: PAYTABS_HOSTS.filter((h) => h === o.regionHost),
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

  return {
    id: "paytabs",

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const exp =
        input.currency === "KWD" || input.currency === "BHD" || input.currency === "OMR" ? 3 : 2;
      const major = (input.amountMinor / 10 ** exp).toFixed(exp);
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "payments.create",
          method: "POST",
          url: `https://${o.regionHost}/payment/request`,
          headers: {
            authorization: o.serverKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            profile_id: Number(o.profileId) || o.profileId,
            tran_type: "sale",
            tran_class: "ecom",
            cart_id: input.requestId,
            cart_currency: input.currency,
            cart_amount: Number(major),
            cart_description: input.description,
            paypage_lang: "en",
            callback: input.webhookUrl,
            return: input.returnUrl,
            hide_shipping: true,
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
      const body = res.json as { tran_ref?: unknown; redirect_url?: unknown } | null;
      if (
        res.ok &&
        body &&
        typeof body.tran_ref === "string" &&
        typeof body.redirect_url === "string"
      ) {
        // PayTabs' hosted page has no expiry parameter in the shape used here: Pulse enforces expires_at itself (a late payment
        // is still recorded, and flagged for review).
        return { ok: true, ref: body.tran_ref, url: body.redirect_url, expiresAt: null };
      }
      return { ok: false, code: paytabsErrorCode(res), retryable: false, ambiguous: false };
    },
  };
}

export function paytabsSignature(serverKey: string, raw: string): string {
  return hmac("sha256", serverKey, raw, "hex");
}

export function verifyPaytabsWebhook(
  serverKey: string,
  raw: string,
  header: string | null | undefined,
): boolean {
  if (!header || !serverKey) return false;
  return safeEqual(paytabsSignature(serverKey, raw), header.trim().toLowerCase());
}

type PaytabsCallback = {
  tran_ref?: unknown;
  cart_id?: unknown;
  cart_currency?: unknown;
  cart_amount?: unknown;
  tran_currency?: unknown;
  tran_total?: unknown;
  payment_result?: { response_status?: unknown; response_code?: unknown } | null;
};

export function parsePaytabsEvents(raw: string): PaymentEvent[] {
  const b = JSON.parse(raw) as PaytabsCallback;
  if (typeof b.tran_ref !== "string") throw new Error("not a PayTabs callback");
  const status =
    typeof b.payment_result?.response_status === "string"
      ? b.payment_result.response_status.toUpperCase()
      : "";
  // What was actually charged (tran_total in tran_currency), falling back to the cart.
  const currency =
    typeof b.tran_currency === "string"
      ? b.tran_currency.toUpperCase()
      : typeof b.cart_currency === "string"
        ? b.cart_currency.toUpperCase()
        : null;
  const amountSrc = b.tran_total ?? b.cart_amount;
  const amountMinor =
    currency && (typeof amountSrc === "string" || typeof amountSrc === "number")
      ? majorToMinor(amountSrc, currency)
      : null;
  const code =
    typeof b.payment_result?.response_code === "string"
      ? b.payment_result.response_code.slice(0, 20)
      : status || null;
  const type: PaymentEvent["type"] =
    status === "A"
      ? "paid"
      : status === "X"
        ? "expired"
        : status === "D" || status === "E" || status === "V"
          ? "declined"
          : "ignored";
  return [
    {
      key: `${b.tran_ref}:${status || "none"}`,
      type,
      providerRef: b.tran_ref,
      requestId: typeof b.cart_id === "string" ? b.cart_id : null,
      amountMinor,
      currency,
      code,
    },
  ];
}
