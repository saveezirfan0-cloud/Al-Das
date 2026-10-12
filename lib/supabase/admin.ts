import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types";

export type AdminClient = SupabaseClient<Database>;

let adminClient: AdminClient | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Service-role client. BYPASSES RLS. Only use in server code after a can()
 * check (see CLAUDE.md rule 1). Never import from client components.
 *
 * Pass the signed-in user's id as `actorId` from a server action so the field-level History tab
 * (record_history) can say who made a change: the id travels in the `x-pulse-actor` header, which the
 * database trusts only on service-role requests. Without it the change is attributed to "System".
 */
export function createAdminClient(actorId?: string | null): AdminClient {
  if (actorId && UUID.test(actorId)) {
    const pub = publicEnv();
    const srv = serverEnv();
    return createSupabaseClient<Database>(
      pub.NEXT_PUBLIC_SUPABASE_URL,
      srv.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "X-Client-Info": "pulse-server", "x-pulse-actor": actorId } },
      },
    );
  }
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
