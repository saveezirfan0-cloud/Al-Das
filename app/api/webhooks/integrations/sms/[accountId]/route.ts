import { smsWebhookSpec } from "@/lib/integrations/sms/receipts";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SMS delivery receipts. Signature-verified, rate limited, idempotent per (message, status), forward-only on the stored status.
 * The shared steps are in lib/integrations/webhook-route.ts.
 */
export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return receiveIntegrationWebhook(request, accountId, "sms", smsWebhookSpec());
}
