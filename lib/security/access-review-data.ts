import "server-only";

import { latestOf, type ReviewUser } from "@/lib/security/access-review";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Gathers the facts an access review needs: every member of the org (active and suspended), their role,
 * when we last saw them, and the API keys they own. Service role, called only after a security.manage check.
 */
export async function gatherReviewUsers(admin: AdminClient, orgId: string): Promise<ReviewUser[]> {
  const [{ data: members }, { data: keys }, { data: events }, { data: sessions }] =
    await Promise.all([
      admin
        .from("memberships")
        .select(
          "id, user_id, status, presence_at, created_at, roles(name, permissions, require_mfa), profiles(first_name, last_name, email)",
        )
        .eq("org_id", orgId),
      admin
        .from("api_keys")
        .select("id, name, key_prefix, last_used_at, created_by")
        .eq("org_id", orgId)
        .is("revoked_at", null),
      // The latest 5,000 of each, read in pages (PostgREST returns at most 1,000 per request).
      fetchAll(
        (from, to) =>
          admin
            .from("auth_events")
            .select("user_id, at")
            .eq("org_id", orgId)
            .in("event_type", ["sign_in", "mfa_verified"])
            .order("at", { ascending: false })
            .order("id")
            .range(from, to),
        { max: 5000 },
      ),
      fetchAll(
        (from, to) =>
          admin
            .from("user_sessions")
            .select("user_id, last_seen_at")
            .eq("org_id", orgId)
            .order("last_seen_at", { ascending: false })
            .order("id")
            .range(from, to),
        { max: 5000 },
      ),
    ]);

  const lastSignIn = new Map<string, string>();
  for (const e of events ?? [])
    if (e.user_id && !lastSignIn.has(e.user_id)) lastSignIn.set(e.user_id, e.at);
  const lastSeen = new Map<string, string>();
  for (const s of sessions ?? [])
    if (!lastSeen.has(s.user_id)) lastSeen.set(s.user_id, s.last_seen_at);
  const keysByOwner = new Map<string, ReviewUser["apiKeys"]>();
  for (const k of keys ?? []) {
    if (!k.created_by) continue;
    const list = keysByOwner.get(k.created_by) ?? [];
    list.push({ id: k.id, name: k.name, prefix: k.key_prefix, lastUsedAt: k.last_used_at });
    keysByOwner.set(k.created_by, list);
  }

  return (members ?? []).map((m) => {
    const perms = Array.isArray(m.roles?.permissions)
      ? (m.roles.permissions as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const name = `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim();
    return {
      userId: m.user_id,
      membershipId: m.id,
      name: name || m.profiles?.email || "Unknown user",
      email: m.profiles?.email ?? "",
      roleName: m.roles?.name ?? "Unknown role",
      rolePermissions: perms,
      status: m.status as "active" | "suspended",
      lastActiveAt: latestOf(lastSignIn.get(m.user_id), lastSeen.get(m.user_id), m.presence_at),
      joinedAt: m.created_at,
      apiKeys: keysByOwner.get(m.user_id) ?? [],
      mfaRequired: m.roles?.require_mfa === true,
    };
  });
}
