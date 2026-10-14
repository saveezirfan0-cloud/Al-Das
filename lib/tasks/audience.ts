import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import { memberCanSeeTask } from "@/lib/tasks/visibility";

/**
 * The people among `userIds` who are active members of the org and could open a task in this branch. Used before a
 * task.assigned or task.mentioned notification, so nobody is sent a link they cannot open.
 */
export async function taskAudience(
  admin: AdminClient,
  orgId: string,
  userIds: readonly string[],
  locationId: string | null,
): Promise<string[]> {
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return [];
  const { data } = await admin
    .from("memberships")
    .select("user_id, branch_scope, roles(permissions), membership_locations(location_id)")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("user_id", ids);
  return (data ?? [])
    .map((m) => ({
      user_id: m.user_id,
      branch_scope: m.branch_scope,
      permissions: ((m.roles as { permissions?: unknown } | null)?.permissions as unknown[]) ?? [],
      locations: ((m.membership_locations as Array<{ location_id: string }> | null) ?? []).map(
        (l) => l.location_id,
      ),
    }))
    .filter((m) => memberCanSeeTask(m, locationId))
    .map((m) => m.user_id);
}
