import "server-only";

import type { ClientField } from "@/components/filter-builder/filter-builder";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import { loose } from "@/lib/portal/db";
import { buildPortalFieldRegistry } from "@/lib/portal/filter-registry";
import { getPortalObject, PORTAL_OBJECTS } from "@/lib/portal/objects";
import { linkOptions } from "@/lib/portal/service";
import type { PortalObjectDef } from "@/lib/portal/types";
import type { AdminClient } from "@/lib/supabase/admin";

export type SavedViewDto = {
  id: string;
  name: string;
  filter: unknown;
  columns: unknown;
  sort: unknown;
  ownerId: string;
  sharedAll: boolean;
  sharedTeamIds: string[];
};

/**
 * Orgs created before an object existed (or never seeded, e.g. via the onboarding RPC) have no
 * portal_objects row for it. seed_portal_objects() is idempotent and never re-enables an object an
 * admin switched off, so it is safe to call whenever the row count is short of the code registry.
 */
export async function ensurePortalObjects(admin: AdminClient, orgId: string): Promise<void> {
  const { count } = await loose(admin)
    .from("portal_objects")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if ((count ?? 0) >= PORTAL_OBJECTS.length) return;
  const { error } = await loose(admin).rpc("seed_portal_objects", { p_org: orgId });
  if (error)
    console.error("[portal] seed_portal_objects failed", {
      code: (error as { code?: string }).code,
    });
}

/**
 * Resolves an object key from the URL / action input to its code definition, but only when the
 * org has it registered and enabled (portal_objects). Returns null otherwise.
 */
export async function resolveEnabledObject(
  admin: AdminClient,
  orgId: string,
  key: string,
): Promise<PortalObjectDef | null> {
  const def = getPortalObject(key);
  if (!def) return null;
  const lookup = () =>
    loose(admin)
      .from("portal_objects")
      .select("key")
      .eq("org_id", orgId)
      .eq("key", key)
      .eq("enabled", true)
      .maybeSingle();
  let { data } = await lookup();
  if (!data) {
    // Only pay for the seed check on a miss (new org, or an object added after the org was created).
    await ensurePortalObjects(admin, orgId);
    ({ data } = await lookup());
  }
  return data ? def : null;
}

/** Keys of the objects enabled for this org (portal_objects rows), in display order. */
export async function enabledObjectKeys(admin: AdminClient, orgId: string): Promise<string[]> {
  await ensurePortalObjects(admin, orgId);
  const { data } = await loose(admin)
    .from("portal_objects")
    .select("key, sort")
    .eq("org_id", orgId)
    .eq("enabled", true)
    .order("sort", { ascending: true });
  return ((data ?? []) as Array<{ key: string }>)
    .map((r) => r.key)
    .filter((k) => !!getPortalObject(k));
}

export async function loadOrgUsers(
  admin: AdminClient,
  orgId: string,
): Promise<Array<{ id: string; label: string }>> {
  const { data: members } = await admin
    .from("memberships")
    .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (members ?? [])
    .map((m) => ({
      id: m.user_id,
      label:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        m.user_id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Registry for an object, with option lists for its link columns (so filters can pick values). */
export async function loadPortalRegistry(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
): Promise<{
  registry: FieldRegistry;
  linkOptions: Record<string, Array<{ value: string; label: string }>>;
}> {
  const opts: Record<string, Array<{ value: string; label: string }>> = {};
  for (const col of def.columns) {
    if (col.type === "link" && col.link)
      opts[col.key] = await linkOptions(admin, orgId, col.link.object, "", 200);
  }
  return { registry: buildPortalFieldRegistry(def, opts), linkOptions: opts };
}

export function toClientFields(registry: FieldRegistry): ClientField[] {
  return registry
    .list()
    .filter((f) => f.available)
    .map(({ key, label, group, type, options, optionsSource, sortable }) => ({
      key,
      label,
      group,
      type,
      options,
      optionsSource,
      sortable,
    }));
}

/** Saved views the member can see: their own, shared with everyone, or shared with one of their teams. */
export async function listSavedViews(
  admin: AdminClient,
  orgId: string,
  userId: string,
  objectKey: string,
): Promise<SavedViewDto[]> {
  const [{ data: views }, { data: teams }] = await Promise.all([
    loose(admin)
      .from("saved_views")
      .select("id, name, filter, columns, sort, owner_id, shared_all, shared_team_ids")
      .eq("org_id", orgId)
      .eq("object_key", objectKey)
      .order("name", { ascending: true }),
    admin.from("team_members").select("team_id").eq("org_id", orgId).eq("user_id", userId),
  ]);
  const myTeams = new Set((teams ?? []).map((t) => t.team_id));
  return ((views ?? []) as Array<Record<string, unknown>>)
    .filter(
      (v) =>
        v.owner_id === userId ||
        v.shared_all === true ||
        ((v.shared_team_ids as string[]) ?? []).some((t) => myTeams.has(t)),
    )
    .map((v) => ({
      id: v.id as string,
      name: v.name as string,
      filter: v.filter,
      columns: v.columns,
      sort: v.sort,
      ownerId: v.owner_id as string,
      sharedAll: v.shared_all === true,
      sharedTeamIds: (v.shared_team_ids as string[]) ?? [],
    }));
}
