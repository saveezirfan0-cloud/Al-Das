import { messagingHandshake, messagingWebhookSpec } from "@/lib/integrations/meta-messaging/server";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Facebook Messenger conversations with the Page (Phase 20e). GET is Meta's subscription handshake (the stored verify token,
 * echoes hub.challenge); POST carries messages, authorised by X-Hub-Signature-256 with the stored app secret, rate limited and
 * idempotent per message id. The shared steps are in lib/integrations/webhook-route.ts.
 */
export async function GET(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return messagingHandshake(request, accountId, "messenger");
}

export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return receiveIntegrationWebhook(
    request,
    accountId,
    "messenger",
    messagingWebhookSpec("messenger"),
  );
}
