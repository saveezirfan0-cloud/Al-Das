import { paymentWebhookSpec } from "@/lib/integrations/payments/webhook";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Payment gateway webhooks. Signature-verified (with a replay window where the gateway signs a timestamp), rate limited,
 * idempotent per event, amounts checked against the stored request. Records the gateway's status in fin_payment_requests only:
 * it never marks an invoice paid and never touches Unite.
 */
export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return receiveIntegrationWebhook(request, accountId, "payments", paymentWebhookSpec);
}
