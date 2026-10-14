/**
 * How a request proves who is calling.
 *   claims  page navigations: verify the JWT signature locally (no Supabase Auth round trip).
 *   strict  anything that can change data: ask Supabase Auth (getUser), which also notices revoked sessions.
 *
 * Pure, so the rule is unit-tested. The middleware decides and forwards the answer in a request header that
 * server code reads; the middleware overwrites the header on every request, so a browser cannot set it.
 */
export const AUTH_MODE_HEADER = "x-pulse-auth";

export type AuthMode = "claims" | "strict";

export function authModeFor(input: {
  method: string;
  pathname: string;
  hasServerActionHeader: boolean;
  optOut?: boolean;
}): AuthMode {
  if (input.optOut) return "strict";
  if (input.hasServerActionHeader) return "strict";
  // API routes (exports, uploads, anything a script could call) are not page navigations: always ask Auth.
  if (input.pathname === "/api" || input.pathname.startsWith("/api/")) return "strict";
  const method = input.method.toUpperCase();
  return method === "GET" || method === "HEAD" ? "claims" : "strict";
}

export function isAuthMode(value: string | null | undefined): value is AuthMode {
  return value === "claims" || value === "strict";
}

/**
 * The request path, forwarded by the middleware for server code that cannot otherwise see it (lib/auth/session.ts uses
 * it to record finance access window refusals on /finance, /accounting and their API routes). Overwritten on every
 * request like the auth mode header; never used to grant anything.
 */
export const REQUEST_PATH_HEADER = "x-pulse-path";
