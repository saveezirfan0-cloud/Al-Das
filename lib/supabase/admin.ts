import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types";

export type AdminClient = SupabaseClient<Database>;

let adminClient: AdminClient | undefined;

/**
 * Service-role client. BYPASSES RLS. Only use in server code after a can()
 * check (see CLAUDE.md rule 1). Never import from client components.
 */
export function createAdminClient(): AdminClient {
  if (!adminClient) {
    const pub = publicEnv();
    const srv = serverEnv();
    adminClient = createSupabaseClient<Database>(
      pub.NEXT_PUBLIC_SUPABASE_URL,
      srv.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "X-Client-Info": "pulse-server" } },
      },
    );
  }
  return adminClient;
}
