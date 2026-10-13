import { mailboxWebhookSpec } from "@/lib/finance/mailbox-server";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The finance mailbox: the mail service posts each message sent to the accounts mailbox here (HTTP basic auth with the
 * stored password). Attachments from allow-listed senders become finance documents in the Finance inbox; nothing else of
 * the message is kept. The shared steps are in lib/integrations/webhook-route.ts.
 */
export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  return receiveIntegrationWebhook(request, accountId, "finance_mailbox", mailboxWebhookSpec());
}
