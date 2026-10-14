import "server-only";

import type { MemberLike } from "@/lib/auth/can";
import {
  canRestore,
  daysLeft,
  readRestoreWindowDays,
  SOFT_DELETE_BROADCAST_EVENT,
  SOFT_DELETE_ENTITIES,
  softDeleteChannelName,
  type SoftDeleteEntity,
} from "@/lib/soft-delete/rules";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Soft delete with a restore window (docs/35_SOFT_DELETE_NOTES.md). Server code only, always after can(): the database
 * functions are service-role only and take the org explicitly. The caller writes the audit row.
 */

/** Moves records to the bin. Returns the ids actually moved (already deleted, erased or other-org ids are skipped). */
export async function softDelete(
  admin: AdminClient,
  args: { orgId: string; userId: string | null; entity: SoftDeleteEntity; ids: string[] },
): Promise<string[]> {
  if (args.ids.length === 0) return [];
  const { data, error } = await admin.rpc("soft_delete_records", {
    p_org: args.orgId,
    p_entity: args.entity,
    p_ids: args.ids,
    p_actor: args.userId ?? undefined,
  });
  if (error) throw new Error(`soft_delete_records failed (${error.code ?? "unknown"})`);
  const moved = (data ?? []) as string[];
  await announceSoftDelete(admin, args.orgId, args.entity, moved);
  return moved;
}

type BroadcastChannel = {
  httpSend: (
    event: string,
    payload: unknown,
    opts?: { timeout?: number },
  ) => Promise<{ success: boolean }>;
};

/**
 * Tells other open screens of the org that rows left their lists (their postgres_changes subscription never sees the
 * UPDATE: RLS hides the new row from them). One REST broadcast, ids only, best effort: a failure only means another
 * person's list refreshes on its next load.
 */
export async function announceSoftDelete(
  admin: AdminClient,
  orgId: string,
  entity: SoftDeleteEntity,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const client = admin as unknown as {
    channel?: (name: string) => BroadcastChannel;
    removeChannel?: (ch: unknown) => Promise<unknown>;
  };
  if (typeof client.channel !== "function") return;
  try {
    const ch = client.channel(softDeleteChannelName(orgId));
    if (typeof ch?.httpSend !== "function") return;
    await ch.httpSend(SOFT_DELETE_BROADCAST_EVENT, { entity, ids }, { timeout: 2000 });
    await client.removeChannel?.(ch);
  } catch {
    // Best effort; nothing logged (no ids or titles either way).
  }
}

export async function loadRestoreWindowDays(admin: AdminClient, orgId: string): Promise<number> {
  const { data } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
  return readRestoreWindowDays(data?.settings);
}

/** The kinds of deleted record this member may see and restore. */
export function restorableEntities(member: MemberLike): SoftDeleteEntity[] {
  return SOFT_DELETE_ENTITIES.filter((e) => canRestore(member, e));
}

export type DeletedItemView = {
  entity: SoftDeleteEntity;
  recordId: string;
  title: string;
  deletedBy: string | null;
  deletedAt: string;
  daysLeft: number;
};

export const DELETED_PAGE_SIZE = 100;

/**
 * One page of the bin as this member may see it, newest first. The database (public.list_deleted_items) filters by the
 * kinds they may restore and by their enquiry view before paging, so older items stay reachable page by page.
 */
export async function listDeletedItems(
  admin: AdminClient,
  member: MemberLike,
  windowDays: number,
  opts: { offset?: number; limit?: number; now?: Date } = {},
): Promise<{ items: DeletedItemView[]; hasMore: boolean }> {
  const kinds = restorableEntities(member);
  if (kinds.length === 0) return { items: [], hasMore: false };
  const limit = Math.min(500, Math.max(1, opts.limit ?? DELETED_PAGE_SIZE));
  const { data, error } = await admin.rpc("list_deleted_items", {
    p_org: member.orgId,
    p_user: member.userId,
    p_kinds: kinds,
    p_limit: limit + 1,
    p_offset: Math.max(0, opts.offset ?? 0),
  });
  if (error) throw new Error(`list_deleted_items failed (${error.code ?? "unknown"})`);
  const rows = (data ?? []).filter((r) =>
    (SOFT_DELETE_ENTITIES as readonly string[]).includes(r.entity),
  );
  const page = rows.slice(0, limit);

  const people = new Map<string, string>();
  const by = [...new Set(page.map((r) => r.deleted_by).filter((x): x is string => !!x))];
  if (by.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", by);
    for (const p of profiles ?? [])
      people.set(p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "A team member");
  }

  const now = opts.now ?? new Date();
  return {
    items: page.map((r) => ({
      entity: r.entity as SoftDeleteEntity,
      recordId: r.record_id,
      title: r.title,
      deletedBy: r.deleted_by ? (people.get(r.deleted_by) ?? "A former member") : null,
      deletedAt: r.deleted_at,
      daysLeft: daysLeft(r.deleted_at, windowDays, now),
    })),
    hasMore: rows.length > limit,
  };
}
