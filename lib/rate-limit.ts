import "server-only";

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Fixed-window rate limiting backed by Postgres (public.rate_limit_hit), so it
 * works across Vercel instances without Redis. Keys are scope + sha256(id): IPs,
 * emails and API-key ids are never stored in clear. The Phase 10 public API plugs
 * in with `checkRateLimit(admin, "public-api", apiKeyId, RATE_RULES.publicApi)`.
 */

export type RateRule = {
  limit: number;
  windowSec: number;
  /** When the limiter itself fails: true lets the request through (default), false rejects it. */
  failOpen?: boolean;
};

export type RateResult = { allowed: boolean; hits: number; retryAfter: number };

export const RATE_RULES = {
  /** Counts only requests that FAIL signature verification; genuine Meta traffic is never throttled. */
  webhookBadSignature: { limit: 30, windowSec: 60, failOpen: true },
  /** Counts only requests with a wrong X-Job-Secret. */
  jobsBadSecret: { limit: 20, windowSec: 60, failOpen: true },
  loginPerIp: { limit: 30, windowSec: 600, failOpen: false },
  loginPerEmail: { limit: 8, windowSec: 900, failOpen: false },
  magicLinkPerEmail: { limit: 5, windowSec: 900, failOpen: false },
  inviteAcceptPerIp: { limit: 15, windowSec: 600, failOpen: false },
  workspaceCreatePerUser: { limit: 5, windowSec: 3600, failOpen: false },
  contactsExportPerUser: { limit: 6, windowSec: 60, failOpen: false },
  /** Counts only requests with an unknown flow webhook token (guessing). */
  flowWebhookBadToken: { limit: 30, windowSec: 60, failOpen: true },
  /** Accepted calls to one flow's incoming webhook. */
  flowWebhookPerFlow: { limit: 120, windowSec: 60, failOpen: true },
  /** Manual "run flow" shortcuts from the inbox, per user. */
  flowShortcutPerUser: { limit: 60, windowSec: 60, failOpen: false },
  /** Phase 10 /api/public/v1, per API key. */
  publicApi: { limit: 120, windowSec: 60, failOpen: true },
} as const satisfies Record<string, RateRule>;

/** Best-effort client IP behind Vercel's edge; "unknown" lumps unidentifiable callers together. */
export function clientIp(h: Pick<Headers, "get">): string {
  const vercel = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

export function rateKey(scope: string, id: string): string {
  const digest = createHash("sha256").update(id.trim().toLowerCase()).digest("hex").slice(0, 32);
  return `${scope}:${digest}`;
}

type RpcClient = Pick<AdminClient, "rpc">;

export async function checkRateLimit(
  admin: RpcClient,
  scope: string,
  id: string,
  rule: RateRule,
): Promise<RateResult> {
  const failOpen = rule.failOpen ?? true;
  const fallback: RateResult = failOpen
    ? { allowed: true, hits: 0, retryAfter: 0 }
    : { allowed: false, hits: 0, retryAfter: rule.windowSec };
  try {
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_key: rateKey(scope, id),
      p_limit: rule.limit,
      p_window_seconds: rule.windowSec,
    });
    const row = data?.[0];
    if (error || !row) {
      console.error("[rate-limit] check failed", { scope, code: error?.code });
      return fallback;
    }
    return { allowed: row.allowed, hits: row.hits, retryAfter: row.retry_after };
  } catch (err) {
    console.error("[rate-limit] check threw", {
      scope,
      error: err instanceof Error ? err.name : "unknown",
    });
    return fallback;
  }
}

export function tooManyRequests(result: Pick<RateResult, "retryAfter">): NextResponse {
  return NextResponse.json(
    { error: "rate_limited", retry_after: result.retryAfter },
    { status: 429, headers: { "Retry-After": String(Math.max(1, result.retryAfter)) } },
  );
}

/** Wrap a route handler: counts every call under `scope`/<key(request)> and answers 429 over the limit. */
export function withRateLimit<Ctx>(
  opts: {
    scope: string;
    rule: RateRule;
    admin: () => RpcClient;
    key: (request: Request) => string | Promise<string>;
  },
  handler: (request: Request, ctx: Ctx) => Promise<Response>,
) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    const result = await checkRateLimit(opts.admin(), opts.scope, await opts.key(request), opts.rule);
    if (!result.allowed) return tooManyRequests(result);
    return handler(request, ctx);
  };
}

/** Human-readable wait for form errors ("about 3 minutes"). */
export function waitText(retryAfterSec: number): string {
  if (retryAfterSec < 90) return "a minute";
  return `about ${Math.ceil(retryAfterSec / 60)} minutes`;
}
