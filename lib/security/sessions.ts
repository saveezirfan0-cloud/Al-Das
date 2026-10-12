import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminClient } from "@/lib/supabase/admin";
import { readTokenClaims } from "@/lib/security/jwt";
import type { Database } from "@/lib/supabase/types";

export type SessionScope = "this_device" | "others" | "everywhere";

const REASON = {
  this_device: "signed_out",
  others: "signed_out_others",
  everywhere: "signed_out_everywhere",
} as const;

/** The GoTrue session id of the request's own session, from the access token the server client holds. */
export async function currentSessionId(supabase: SupabaseClient<Database>): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return readTokenClaims(data.session?.access_token).sessionId;
}

/**
 * Marks our device rows revoked to match a sign-out. The actual token revocation is done by
 * supabase.auth.signOut({ scope }) in the caller; this keeps the session list honest.
 */
export async function endSessionRows(
  admin: AdminClient,
  supabase: SupabaseClient<Database>,
  member: { userId: string; orgId: string },
  scope: SessionScope,
): Promise<void> {
  try {
    const current = await currentSessionId(supabase);
    let query = admin
      .from("user_sessions")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: REASON[scope] })
      .eq("user_id", member.userId)
      .is("revoked_at", null);
    if (scope === "this_device") {
      if (!current) return;
      query = query.eq("session_id", current);
    } else if (scope === "others" && current) {
      query = query.neq("session_id", current);
    }
    const { error } = await query;
    if (error) console.error("[sessions] revoke rows failed", { code: error.code });
  } catch (err) {
    console.error("[sessions] endSessionRows threw", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
