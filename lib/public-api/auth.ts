import "server-only";

import type { NextResponse } from "next/server";

import { hashApiKey, hasScope, looksLikeApiKey, parseBearer, type ApiKeyScope } from "@/lib/public-api/keys";
import { apiError } from "@/lib/public-api/http";
import { secretMatches } from "@/lib/jobs/secret";
import type { AdminClient } from "@/lib/supabase/admin";

export type ApiKeyContext = { keyId: string; orgId: string; scopes: string[] };

export type AuthResult = { ok: true; ctx: ApiKeyContext } | { ok: false; response: NextResponse };

/**
 * Per-key rate limit hook. Phase 11 (hardening) installs a real limiter with setRateLimiter();
 * until then every request is allowed. Kept here so no route has to change when it lands.
 */
export type RateLimiter = (ctx: ApiKeyContext) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
let limiter: RateLimiter = async () => ({ allowed: true });
export function setRateLimiter(next: RateLimiter): void {
  limiter = next;
}

const LAST_USED_THROTTLE_MS = 5 * 60_000;

function unauthorized(code: string, message: string): AuthResult {
  return { ok: false, response: apiError(401, code, message, { headers: { "WWW-Authenticate": 'Bearer realm="pulse"' } }) };
}

/**
 * Authorization: Bearer pk_...  →  org + scopes. The key itself is never stored or logged; the lookup
 * is by its SHA-256. Unknown, malformed and wrong-secret keys all answer the same, so keys cannot be
 * enumerated; "revoked" and "expired" are only revealed once the hash matched.
 */
export async function authenticateApiKey(request: Request, admin: AdminClient, now = new Date()): Promise<AuthResult> {
  const token = parseBearer(request.headers.get("authorization"));
  if (!token) return unauthorized("missing_api_key", "Send your API key as 'Authorization: Bearer <key>'.");
  if (!looksLikeApiKey(token)) return unauthorized("invalid_api_key", "That API key is not valid.");

  const hash = hashApiKey(token);
  const { data: row } = await admin
    .from("api_keys")
    .select("id, org_id, key_hash, scopes, expires_at, revoked_at, last_used_at")
    .eq("key_hash", hash)
    .maybeSingle();
  // The DB matched on the hash; compare again in constant time before trusting the row.
  if (!row || !secretMatches(row.key_hash, hash)) return unauthorized("invalid_api_key", "That API key is not valid.");
  if (row.revoked_at) return unauthorized("api_key_revoked", "This API key has been revoked.");
  if (row.expires_at && new Date(row.expires_at) <= now) return unauthorized("api_key_expired", "This API key has expired.");

  if (!row.last_used_at || now.getTime() - new Date(row.last_used_at).getTime() > LAST_USED_THROTTLE_MS) {
    await admin.from("api_keys").update({ last_used_at: now.toISOString() }).eq("id", row.id); // best effort
  }

  const ctx: ApiKeyContext = { keyId: row.id, orgId: row.org_id, scopes: row.scopes };
  const limit = await limiter(ctx);
  if (!limit.allowed) {
    return {
      ok: false,
      response: apiError(429, "rate_limited", "Too many requests.", {
        headers: limit.retryAfterSeconds ? { "Retry-After": String(limit.retryAfterSeconds) } : undefined,
      }),
    };
  }
  return { ok: true, ctx };
}

export function requireScope(ctx: ApiKeyContext, scope: ApiKeyScope): NextResponse | null {
  return hasScope(ctx.scopes, scope) ? null : apiError(403, "insufficient_scope", `This API key lacks the '${scope}' scope.`);
}
