import { sanoflowWebhookSpec } from "@/lib/integrations/sanoflow/server";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sanoflow's "patient replied / booked" call (OQ-182; replaces Make's "Chronic Update" webhook). Token-checked, rate limited,
 * idempotent per body and day. The shared steps are in lib/integrations/webhook-route.ts.
 */
export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return receiveIntegrationWebhook(request, accountId, "sanoflow", sanoflowWebhookSpec());
}
