import { esignWebhookSpec } from "@/lib/integrations/esign/server";
import { supabaseEsignStorage } from "@/lib/integrations/esign/storage";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * E-signature events (signed, declined, expired, cancelled). Authorised by the provider's event hash, rate limited, idempotent per event
 * and forward-only on the request's status. The shared steps are in lib/integrations/webhook-route.ts. The provider wants the plain
 * text "Hello API Event Received" as its acknowledgement.
 */
export async function POST(request: Request, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  const admin = createAdminClient();
  return receiveIntegrationWebhook(
    request,
    accountId,
    "esign",
    esignWebhookSpec({ storage: () => supabaseEsignStorage(admin) }),
    { admin },
  );
}
