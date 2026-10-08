import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type NewNotification = {
  orgId: string;
  userId: string;
  type: string; // 'system' | 'mention' | 'task.due' | 'job.failed' ...
  title: string;
  body?: string | null;
  payload?: Json;
};

/** In-app notification for one user. Realtime picks up the insert. */
export async function createNotification(admin: AdminClient, n: NewNotification): Promise<void> {
  const { error } = await admin.from("notifications").insert({
    org_id: n.orgId,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    payload: n.payload ?? {},
  });
  if (error) console.error("[notifications] insert failed", { type: n.type, code: error.code });
}

/** Notify every member of an org who holds a permission (e.g. settings.manage for job failures). */
export async function notifyMembersWithPermission(
  admin: AdminClient,
  orgId: string,
  permission: string,
  n: Omit<NewNotification, "orgId" | "userId">,
): Promise<number> {
  const { data: members } = await admin
    .from("memberships")
    .select("user_id, roles(permissions)")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (!members) return 0;
  const targets = members.filter((m) => {
    const perms = (m.roles?.permissions as unknown[]) ?? [];
    return perms.includes("*") || perms.includes(permission);
  });
  if (targets.length === 0) return 0;
  const { error } = await admin.from("notifications").insert(
    targets.map((m) => ({
      org_id: orgId,
      user_id: m.user_id,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      payload: n.payload ?? {},
    })),
  );
  if (error)
    console.error("[notifications] bulk insert failed", { type: n.type, code: error.code });
  return targets.length;
}
