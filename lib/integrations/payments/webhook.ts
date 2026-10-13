import "server-only";

import { applyPaymentEvent } from "@/lib/integrations/payments/apply";
import { readPaymentsConfig } from "@/lib/integrations/payments/config";
import { parsePaytabsEvents, verifyPaytabsWebhook } from "@/lib/integrations/payments/paytabs";
import { parseStripeEvents, verifyStripeWebhook } from "@/lib/integrations/payments/stripe";
import type { PaymentEvent } from "@/lib/integrations/payments/types";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import type { AccountRow } from "@/lib/integrations/accounts";
import { readConfig } from "@/lib/integrations/accounts";

/** The webhook rules for whichever gateway this account uses. */
export function paymentWebhookSpec(account: AccountRow): WebhookSpec | null {
  const provider = readPaymentsConfig(readConfig(account)).provider;
  const handle: WebhookSpec["handle"] = async (event, ctx) =>
    applyPaymentEvent(ctx.admin, {
      orgId: ctx.account.org_id,
      provider,
      event: event.data as PaymentEvent,
    });
  if (provider === "stripe") {
    return {
      kind: "payments",
      provider: "stripe",
      verify: (ctx) =>
        verifyStripeWebhook(
          ctx.secrets.webhook_secret ?? "",
          ctx.raw,
          ctx.headers.get("stripe-signature"),
          ctx.nowMs,
        ),
      parse: (raw) => parseStripeEvents(raw).map((e) => ({ key: e.key, data: e })),
      handle,
    };
  }
  return {
    kind: "payments",
    provider: "paytabs",
    verify: (ctx) =>
      verifyPaytabsWebhook(ctx.secrets.server_key ?? "", ctx.raw, ctx.headers.get("signature")),
    parse: (raw) => parsePaytabsEvents(raw).map((e) => ({ key: e.key, data: e })),
    handle,
  };
}
