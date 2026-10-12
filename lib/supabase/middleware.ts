import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isMfaExemptPath, mfaGate } from "@/lib/security/mfa";
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
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

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
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not run code between createServerClient and getUser(): it can cause
  // random sign-outs (per Supabase SSR docs).
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
      const { data: memberships } = await supabase
        .from("memberships")
        .select("org_id, roles(require_mfa)")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at");
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
