import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isMfaExemptPath, mfaGate } from "@/lib/security/mfa";
import { AUTH_MODE_HEADER, authModeFor } from "@/lib/supabase/auth-mode";
import type { Database } from "@/lib/supabase/types";

const PUBLIC_PREFIXES = [
  "/login",
  "/invite",
  "/auth",
  "/api/jobs",
  "/api/webhooks",
  "/api/public",
  "/_next",
  "/favicon",
  "/manifest.webmanifest",
];

function isPublicPath(pathname: string) {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p),
  );
}

/**
 * Refreshes the Supabase session cookie on every request and redirects
 * signed-out users away from the app. Keep this light: no DB queries here.
 *
 * Phase 13 (speed): page navigations (GET/HEAD) verify the access token locally with getClaims() instead of a
 * round trip to Supabase Auth on every request. Anything that can change data (server actions, POST/PUT/PATCH/
 * DELETE) still calls getUser(), which asks Auth whether the session is still valid. The chosen mode is passed to
 * the page through a request header (lib/supabase/auth-mode.ts) so lib/auth/session.ts does the same.
 * Two-step verification below is unchanged: it reads the assurance level from the same session.
 */
export async function updateSession(request: NextRequest) {
  const authMode = authModeFor({
    method: request.method,
    pathname: request.nextUrl.pathname,
    hasServerActionHeader: request.headers.has("next-action"),
    optOut: process.env.PULSE_VERIFY_JWT_LOCALLY === "0",
  });
  // A client-supplied value never survives: the header is rebuilt from the request on every pass.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set(AUTH_MODE_HEADER, authMode);
    return NextResponse.next({ request: { headers } });
  };
  let response = forward();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

  const supabase = createServerClient<Database>(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = forward();
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not run code between createServerClient and getUser(): it can cause
  // random sign-outs (per Supabase SSR docs).
  let user: { id: string } | null;
  if (authMode === "claims") {
    // Verified against the project's signing keys (cached JWKS); no Auth round trip. Projects still on a
    // shared-secret JWT make getClaims() fall back to getUser() itself, so this is never weaker.
    const { data } = await supabase.auth.getClaims();
    user = data?.claims?.sub ? { id: data.claims.sub } : null;
  } else {
    const {
      data: { user: verified },
    } = await supabase.auth.getUser();
    user = verified;
  }

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.searchParams.set("next", pathname);
    return NextResponse.redirect(redirect);
  }

  // Two-step verification. A session already at aal2 costs nothing; only an aal1 session without a
  // verified factor needs one query to learn whether its role requires MFA.
  if (user && !isPublicPath(pathname) && !isMfaExemptPath(pathname)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const base = {
      pathname,
      currentLevel: aal?.currentLevel,
      hasVerifiedFactor: aal?.nextLevel === "aal2",
    };
    let decision = mfaGate({ ...base, required: false });
    if (decision === "allow" && aal?.currentLevel !== "aal2") {
      const preferred = request.cookies.get("pulse_org")?.value;
      const { data: memberships, error: roleError } = await supabase
        .from("memberships")
        .select("org_id, roles(require_mfa)")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at");
      if (roleError) {
        // Fail closed: if we cannot tell whether this role needs a second step, do not assume it does not.
        return NextResponse.json(
          { error: "temporarily unavailable" },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }
      const active = memberships?.find((m) => m.org_id === preferred) ?? memberships?.[0];
      decision = mfaGate({ ...base, required: active?.roles?.require_mfa === true });
    }
    if (decision !== "allow") {
      const redirect = request.nextUrl.clone();
      redirect.pathname = decision === "enroll" ? "/mfa/enroll" : "/mfa/verify";
      redirect.search = "";
      redirect.searchParams.set("next", pathname);
      return NextResponse.redirect(redirect);
    }
  }

  if (user && pathname === "/login") {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/dashboard";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}
