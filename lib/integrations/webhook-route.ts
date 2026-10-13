import "server-only";

import { NextResponse } from "next/server";

import {
  loadAccountById,
  readConfig,
  readSecrets,
  type AccountRow,
  type Config,
  type Secrets,
} from "@/lib/integrations/accounts";
import type { IntegrationKind } from "@/lib/integrations/catalog";
import { MAX_INTEGRATION_WEBHOOK_BYTES } from "@/lib/integrations/webhook";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * The shared plumbing of every inbound integration webhook (CLAUDE.md Phase 19 conventions):
 *
 *   unknown or switched-off account  -> 404 (the same answer for both, so the URL reveals nothing)
 *   body over the cap                -> 413
 *   signature wrong                  -> 401 (failed attempts per IP are rate limited)
 *   too many calls for this account  -> 429
 *   each event: claim its idempotency key (integration_webhook_events) -> handle -> remember the outcome.
 *   A key already claimed is skipped, so a provider that delivers twice acts once. If handling throws, the claim is released
 *   and the route answers 500 so the provider retries.
 *
 * The provider adapter supplies `verify` (a constant-time signature check, with its own replay window if the provider signs a
 * timestamp), `parse` (raw body -> events with a stable key) and `handle`.
 */

export type WebhookEvent = { key: string; data: unknown };

export type VerifyContext = {
  raw: string;
  headers: Headers;
  secrets: Secrets;
  config: Config;
  account: AccountRow;
  nowMs: number;
  /** The request's query string including the leading "?" (or ""). */
  search: string;
};

export type WebhookSpec = {
  kind: IntegrationKind;
  provider: string;
  verify: (ctx: VerifyContext) => boolean;
  parse: (raw: string, ctx: VerifyContext) => WebhookEvent[];
  /** Returns a short outcome word stored with the key ("applied", "duplicate_payment", ...). */
  handle: (event: WebhookEvent, ctx: VerifyContext & { admin: AdminClient }) => Promise<string>;
};

export async function receiveIntegrationWebhook(
  request: Request,
  accountId: string,
  kind: IntegrationKind,
  specFor: WebhookSpec | ((account: AccountRow) => WebhookSpec | null),
  deps: { admin?: AdminClient; now?: () => number } = {},
): Promise<Response> {
  const admin = deps.admin ?? createAdminClient();
  const nowMs = (deps.now ?? Date.now)();
  const ip = clientIp(request.headers);

  const account = await loadAccountById(admin, accountId, kind);
  const spec =
    account && account.enabled
      ? typeof specFor === "function"
        ? specFor(account)
        : specFor
      : null;
  if (!account || !account.enabled || !spec) {
    // Unknown ids count as bad attempts so the URL space cannot be walked.
    const limited = await checkRateLimit(
      admin,
      "integration-webhook-bad-signature",
      ip,
      RATE_RULES.integrationWebhookBadSignature,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const perAccount = await checkRateLimit(
    admin,
    "integration-webhook",
    account.id,
    RATE_RULES.integrationWebhook,
  );
  if (!perAccount.allowed) return tooManyRequests(perAccount);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_INTEGRATION_WEBHOOK_BYTES)
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_INTEGRATION_WEBHOOK_BYTES)
    return NextResponse.json({ error: "payload too large" }, { status: 413 });

  const secrets: Secrets = readSecrets(account);
  if (Object.keys(secrets).length === 0) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  const ctx: VerifyContext = {
    raw,
    headers: request.headers,
    secrets,
    config: readConfig(account),
    account,
    nowMs,
    search: new URL(request.url).search,
  };

  let verified = false;
  try {
    verified = spec.verify(ctx);
  } catch {
    verified = false;
  }
  if (!verified) {
    const limited = await checkRateLimit(
      admin,
      "integration-webhook-bad-signature",
      ip,
      RATE_RULES.integrationWebhookBadSignature,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let events: WebhookEvent[];
  try {
    events = spec.parse(raw, ctx);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  let processed = 0;
  let duplicates = 0;
  for (const event of events) {
    const claim = await admin
      .from("integration_webhook_events")
      .upsert(
        { org_id: account.org_id, provider: spec.provider, event_key: event.key.slice(0, 200) },
        { onConflict: "org_id,provider,event_key", ignoreDuplicates: true },
      )
      .select("id");
    if (claim.error) {
      console.error("[integration-webhook] claim failed", {
        provider: spec.provider,
        code: claim.error.code,
      });
      return NextResponse.json({ error: "store failed" }, { status: 500 });
    }
    const claimId = claim.data?.[0]?.id;
    if (claimId === undefined) {
      duplicates++;
      continue;
    }
    try {
      const outcome = await spec.handle(event, { ...ctx, admin });
      await admin
        .from("integration_webhook_events")
        .update({ outcome: outcome.slice(0, 60) })
        .eq("id", claimId);
      processed++;
    } catch (err) {
      await admin.from("integration_webhook_events").delete().eq("id", claimId);
      console.error("[integration-webhook] handler failed", {
        provider: spec.provider,
        error: redactText(err, 120),
      });
      return NextResponse.json({ error: "processing failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, processed, duplicates }, { status: 200 });
}
