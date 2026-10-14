import "server-only";

import { NextResponse } from "next/server";

import { ensureChannel } from "@/lib/channels/ensure";
import { afterChannelInbound, readReceiveResult } from "@/lib/channels/inbound";
import { serverEnv } from "@/lib/env";
import {
  dbBreakerStore,
  dbCallSink,
  loadAccountById,
  readConfig,
  readSecrets,
  type AccountRow,
} from "@/lib/integrations/accounts";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

import { createMessagingClient, type MessagingClient } from "./client";
import { readMessagingConfig, type MessagingPlatform } from "./config";
import { handshakeChallenge, parseMessagingEvents, verifyMetaMessagingSignature } from "./webhook";

function graphVersion(): string {
  try {
    return serverEnv().META_GRAPH_VERSION;
  } catch {
    return "v21.0";
  }
}

/** The send client for an account, or null when its settings or token are incomplete. Every call is logged without bodies. */
export function buildMessagingClientFor(
  admin: AdminClient,
  account: AccountRow,
  platform: MessagingPlatform,
  fetchFn?: typeof fetch,
): MessagingClient | null {
  const cfg = readMessagingConfig(platform, readConfig(account), graphVersion());
  const token = readSecrets(account).page_access_token;
  if (!cfg || !token) return null;
  return createMessagingClient({
    platform,
    pageId: cfg.pageId,
    accessToken: token,
    graphVersion: cfg.graphVersion,
    fetchFn,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, platform),
  });
}

/**
 * The inbound webhook of one platform (receiveIntegrationWebhook does the 404 / size / signature / rate-limit / claim plumbing).
 * Each message is stored through channel_receive_social(): the sender is matched by the platform-scoped id on this channel, a new
 * sender becomes a contact without a phone, and the message lands in the inbox like a WhatsApp one.
 */
export function messagingWebhookSpec(platform: MessagingPlatform): WebhookSpec {
  return {
    kind: platform,
    provider: platform,
    verify: (ctx) =>
      verifyMetaMessagingSignature(
        ctx.raw,
        ctx.headers.get("x-hub-signature-256"),
        ctx.secrets.app_secret,
      ),
    parse: (raw, ctx) => {
      const cfg = readMessagingConfig(platform, ctx.config);
      if (!cfg) return [];
      return parseMessagingEvents(platform, raw, cfg.recipientId, new Date(ctx.nowMs)).map((e) => ({
        key: e.key,
        data: e,
      }));
    },
    handle: async (event, ctx) => {
      const e = event.data as ReturnType<typeof parseMessagingEvents>[number];
      const cfg = readMessagingConfig(platform, ctx.config);
      if (!cfg) return "not_configured";
      const orgId = ctx.account.org_id;
      const channel = await ensureChannel(ctx.admin, {
        orgId,
        type: platform,
        externalId: cfg.recipientId,
      });
      const at = e.at instanceof Date ? e.at : new Date(String(e.at));
      const { data, error } = await ctx.admin.rpc("channel_receive_social", {
        p_org: orgId,
        p_channel: channel.id,
        p_platform: platform,
        p_external_id: e.senderId,
        p_message_id: e.messageId,
        p_kind: e.kind,
        p_body: e.text ?? "",
        p_at: at.toISOString(),
      });
      if (error) throw new Error(`channel_receive_social failed (${error.code})`);
      const result = readReceiveResult(data);
      if (result.error) return `skipped_${result.error}`;
      if (result.duplicate) return "duplicate";
      await afterChannelInbound(ctx.admin, {
        orgId,
        channelType: platform,
        body: e.text,
        result,
      });
      return result.opened ? "stored_opened" : "stored";
    },
  };
}

/**
 * The subscription handshake (GET): Meta checks that the callback belongs to us by echoing hub.challenge when hub.verify_token
 * equals the token stored (encrypted) for this account. Unknown, switched-off and wrong-token requests all answer 404 and count
 * against the per-IP limit for bad attempts.
 */
export async function messagingHandshake(
  request: Request,
  accountId: string,
  platform: MessagingPlatform,
  deps: { admin?: AdminClient } = {},
): Promise<Response> {
  const admin = deps.admin ?? createAdminClient();
  const account = await loadAccountById(admin, accountId, platform);
  const challenge =
    account && account.enabled
      ? handshakeChallenge(new URL(request.url).searchParams, readSecrets(account).verify_token)
      : null;
  if (!challenge) {
    const limited = await checkRateLimit(
      admin,
      "integration-webhook-bad-signature",
      clientIp(request.headers),
      RATE_RULES.integrationWebhookBadSignature,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
