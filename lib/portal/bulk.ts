import "server-only";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { emit } from "@/lib/events/emit";
import {
  bulkResult,
  bulkTagSchema,
  diffTagSets,
  planBulkEdit,
  tagRowsToAdd,
  type BulkResult,
  type PortalTag,
} from "@/lib/portal/bulk-edit";
import { loose } from "@/lib/portal/db";
import { friendlyDbError } from "@/lib/portal/field-types";
import { requirePortalObject } from "@/lib/portal/objects";
import { canWriteObject } from "@/lib/portal/permissions";
import type { ServiceMember, ServiceResult } from "@/lib/portal/service";
import type { PortalObjectDef } from "@/lib/portal/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Portal bulk edit and portal tags, the server half (docs/33_PORTAL_BULK_EDIT_TAGS_NOTES.md). Like
 * lib/portal/service, every function re-checks the object's permission itself. Pass an admin client made with
 * createAdminClient(member.userId) so record_history names the person.
 */

const FORBIDDEN = "You do not have permission to do that.";
/** Permission for creating, renaming and deleting portal tags (Settings, Tags and "create" in a picker). */
export const PORTAL_TAGS_MANAGE = "portal.tags.manage";

export type { PortalTag };

function truncate(v: unknown): unknown {
  return typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
}

/** Ids (of the given ones) that are records of this object in the member's organisation. */
async function existingIds(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  let q = loose(admin).from(def.table).select("id").eq("org_id", orgId).in("id", ids);
  // Records in Recently deleted (docs/35) are not edited or tagged in bulk.
  if (def.softDeleteEntity) q = q.is("deleted_at", null);
  const { data, error } = await q;
  if (error) throw new Error("portal record lookup failed");
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Bulk edit of one field
// ---------------------------------------------------------------------------

export async function bulkUpdateRecords(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  input: unknown,
): Promise<ServiceResult<BulkResult>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  const plan = planBulkEdit(def, input);
  if (!plan.ok) return plan;

  // Records in Recently deleted (docs/35) are left alone.
  const ids = def.softDeleteEntity ? await existingIds(admin, member.orgId, def, plan.ids) : plan.ids;

  // One statement in SQL: only this org's rows, only rows whose value differs (portal_bulk_update).
  const { data, error } = await loose(admin).rpc("portal_bulk_update", {
    p_org_id: member.orgId,
    p_object_key: def.key,
    p_ids: ids,
    p_column: plan.column.key,
    p_value: plan.value as Json,
  });
  if (error) return { ok: false, error: friendlyDbError(error) };
  const changed = (data ?? []) as Array<{
    record_id: string;
    old_value: unknown;
    new_value: unknown;
  }>;
  const result = bulkResult(plan.ids.length, changed.length);

  if (changed.length > 0) {
    // Timeline: one event per record (reference data only, values truncated like a single edit).
    const { error: evErr } = await loose(admin)
      .from("portal_record_events")
      .insert(
        changed.map((r) => ({
          org_id: member.orgId,
          object_key: def.key,
          record_id: r.record_id,
          type: "updated",
          actor_id: member.userId,
          payload: {
            bulk: true,
            changes: {
              [plan.column.key]: { from: truncate(r.old_value), to: truncate(r.new_value) },
            },
          },
        })),
      );
    if (evErr) console.error("[portal] bulk event insert failed", { code: evErr.code });
  }

  // One audit row for the whole action: the field and the counts, never the value.
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.records_bulk_updated",
    entity: def.key,
    diff: {
      field: plan.column.key,
      cleared: plan.value === null,
      requested: result.requested,
      updated: result.updated,
    },
  });

  // Same domain event as a single edit, so flows and outbound webhooks see each change.
  const CHUNK = 20;
  for (let i = 0; i < changed.length; i += CHUNK) {
    await Promise.all(
      changed.slice(i, i + CHUNK).map((r) =>
        emit(member.orgId, "portal.record_updated", {
          object: def.key,
          record_id: r.record_id,
          fields: [plan.column.key],
          bulk: true,
        }),
      ),
    );
  }
  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// Tags (scope 'portal')
// ---------------------------------------------------------------------------

export async function listPortalTags(admin: AdminClient, orgId: string): Promise<PortalTag[]> {
  const { data } = await admin
    .from("tags")
    .select("id, name, color")
    .eq("org_id", orgId)
    .eq("scope", "portal")
    .order("name");
  return (data ?? []) as PortalTag[];
}

/** Tag ids per record for the given records of one object (records without tags are absent). */
export async function tagsForRecords(
  admin: AdminClient,
  orgId: string,
  objectKey: string,
  recordIds: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (recordIds.length === 0) return out;
  const { data } = await loose(admin)
    .from("portal_record_tags")
    .select("record_id, tag_id")
    .eq("org_id", orgId)
    .eq("object_key", objectKey)
    .in("record_id", recordIds);
  for (const r of (data ?? []) as Array<{ record_id: string; tag_id: string }>)
    (out[r.record_id] ??= []).push(r.tag_id);
  return out;
}

/** True when every id is a portal tag of this organisation. */
async function allPortalTags(admin: AdminClient, orgId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { count } = await admin
    .from("tags")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("scope", "portal")
    .in("id", ids);
  return (count ?? 0) === ids.length;
}

export async function createPortalTag(
  admin: AdminClient,
  member: ServiceMember,
  name: string,
): Promise<ServiceResult<PortalTag>> {
  if (!can(member, PORTAL_TAGS_MANAGE)) return { ok: false, error: FORBIDDEN };
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 40)
    return { ok: false, error: "Enter a tag name (up to 40 characters)." };
  const { data, error } = await admin
    .from("tags")
    .insert({ org_id: member.orgId, scope: "portal", name: clean })
    .select("id, name, color")
    .single();
  if (error || !data)
    return {
      ok: false,
      error: error?.code === "23505" ? "That tag already exists." : "Could not create the tag.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "tag.created",
    entity: "tag",
    entityId: data.id,
    diff: { scope: "portal" },
  });
  return { ok: true, data: data as PortalTag };
}

/** Replaces one record's tags. Only portal tags of this organisation are accepted. */
export async function setRecordTags(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  recordId: string,
  tagIds: string[],
): Promise<ServiceResult<{ added: number; removed: number }>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  const want = [...new Set(tagIds.map((t) => t.toLowerCase()))];
  if (want.length > 100) return { ok: false, error: "Too many tags." };
  if (!(await allPortalTags(admin, member.orgId, want)))
    return { ok: false, error: "Unknown tag." };
  const found = await existingIds(admin, member.orgId, def, [recordId]);
  if (found.length === 0) return { ok: false, error: "Record not found." };

  const have = (await tagsForRecords(admin, member.orgId, def.key, [recordId]))[recordId] ?? [];
  const { add, remove } = diffTagSets(have, want);
  const l = loose(admin);
  if (add.length) {
    const { error } = await l.from("portal_record_tags").upsert(
      add.map((tag_id) => ({
        org_id: member.orgId,
        object_key: def.key,
        record_id: recordId,
        tag_id,
        created_by: member.userId,
      })),
      { onConflict: "org_id,object_key,record_id,tag_id", ignoreDuplicates: true },
    );
    if (error) return { ok: false, error: "Could not add the tags." };
  }
  if (remove.length) {
    const { error } = await l
      .from("portal_record_tags")
      .delete()
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .eq("record_id", recordId)
      .in("tag_id", remove);
    if (error) return { ok: false, error: "Could not remove the tags." };
  }
  if (add.length || remove.length) {
    await l.from("portal_record_events").insert({
      org_id: member.orgId,
      object_key: def.key,
      record_id: recordId,
      type: "tags",
      actor_id: member.userId,
      payload: { added: add.length, removed: remove.length },
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "portal.record_tags_changed",
      entity: def.key,
      entityId: recordId,
      diff: { added: add.length, removed: remove.length },
    });
  }
  return { ok: true, data: { added: add.length, removed: remove.length } };
}

/** Adds and/or removes tags on up to 500 records of one object. */
export async function bulkTagRecords(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  input: unknown,
): Promise<ServiceResult<BulkResult>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  const parsed = bulkTagSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { ids, add, remove } = parsed.data;
  if (!(await allPortalTags(admin, member.orgId, [...add, ...remove])))
    return { ok: false, error: "Unknown tag." };

  let found: string[];
  try {
    found = await existingIds(admin, member.orgId, def, ids);
  } catch {
    return { ok: false, error: "Could not load the records." };
  }
  const touched = new Set<string>();
  const l = loose(admin);

  if (add.length && found.length) {
    const { data: existing } = await l
      .from("portal_record_tags")
      .select("record_id, tag_id")
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .in("record_id", found)
      .in("tag_id", add);
    const rows = tagRowsToAdd(
      found,
      add,
      (existing ?? []) as Array<{ record_id: string; tag_id: string }>,
    );
    if (rows.length) {
      const { error } = await l.from("portal_record_tags").upsert(
        rows.map((r) => ({
          org_id: member.orgId,
          object_key: def.key,
          record_id: r.record_id,
          tag_id: r.tag_id,
          created_by: member.userId,
        })),
        { onConflict: "org_id,object_key,record_id,tag_id", ignoreDuplicates: true },
      );
      if (error) return { ok: false, error: "Could not add the tags." };
      for (const r of rows) touched.add(r.record_id);
    }
  }
  if (remove.length && found.length) {
    const { data: gone, error } = await l
      .from("portal_record_tags")
      .delete()
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .in("record_id", found)
      .in("tag_id", remove)
      .select("record_id");
    if (error) return { ok: false, error: "Could not remove the tags." };
    for (const r of (gone ?? []) as Array<{ record_id: string }>) touched.add(r.record_id);
  }

  const result = bulkResult(ids.length, touched.size);
  if (touched.size > 0) {
    const { error: evErr } = await l.from("portal_record_events").insert(
      [...touched].map((record_id) => ({
        org_id: member.orgId,
        object_key: def.key,
        record_id,
        type: "tags",
        actor_id: member.userId,
        payload: { bulk: true, added: add.length, removed: remove.length },
      })),
    );
    if (evErr) console.error("[portal] bulk tag event insert failed", { code: evErr.code });
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.records_bulk_tagged",
    entity: def.key,
    diff: {
      tags_added: add.length,
      tags_removed: remove.length,
      requested: result.requested,
      updated: result.updated,
    },
  });
  return { ok: true, data: result };
}
