import { NextResponse, type NextRequest } from "next/server";

import { recordSignIn } from "@/lib/security/auth-events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Exchanges the PKCE code from a magic link / recovery email for a session. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data.user) {
        await recordSignIn(createAdminClient(), {
          userId: data.user.id,
          accessToken: data.session?.access_token ?? null,
          method: "magic_link",
          headers: request.headers,
        });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
