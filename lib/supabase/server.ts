import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Cookie-backed Supabase client for Server Components, Route Handlers and
 * Server Actions. Runs as the signed-in user, so RLS applies.
 */
export async function createClient() {
  // Read cookies first: it opts the caller into dynamic rendering, so `next build`
  // never tries to prerender a page and trips over missing env vars.
  const cookieStore = await cookies();
  const env = publicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component: the middleware refreshes sessions instead.
          }
        },
      },
    },
  );
}
