import "server-only";

import { recordAudit } from "@/lib/audit";
import { can, type MemberLike } from "@/lib/auth/can";
import { emit } from "@/lib/events/emit";
import { parseMentions } from "@/lib/inbox/mentions";
import { createNotification } from "@/lib/notifications";
import { loose } from "@/lib/portal/db";
import { friendlyDbError, parsePortalInput } from "@/lib/portal/field-types";
import { requirePortalObject } from "@/lib/portal/objects";
import { canReadObject, canWriteObject } from "@/lib/portal/permissions";
import type { PortalObjectDef, PortalRow } from "@/lib/portal/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Portal record service: the only code path that writes portal tables. Route handlers, server
 * actions, the Airtable importer and (Phase 8) the flow node "Create/Update Portal Record" all
 * call this, so permission checks, Zod validation, audit, timeline and domain events cannot be
 * skipped. Callers pass the member resolved by lib/auth/session.
 */

export type ServiceMember = MemberLike;

export type ServiceResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const FORBIDDEN = "You do not have permission to do that.";

function truncate(v: unknown): unknown {
  return typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Field-level diff of the keys that changed. Values are truncated; reference/config data only. */
export function diffRecord(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (!sameValue(before[k], after[k]))
      out[k] = { from: truncate(before[k]), to: truncate(after[k]) };
  }
  return out;
}

export async function addRecordEvent(
  admin: AdminClient,
  e: {
    orgId: string;
    objectKey: string;
    recordId: string;
    type: string;
    actorId: string | null;
    payload?: Json;
  },
): Promise<void> {
  const { error } = await loose(admin)
    .from("portal_record_events")
    .insert({
      org_id: e.orgId,
      object_key: e.objectKey,
      record_id: e.recordId,
      type: e.type,
      actor_id: e.actorId,
      payload: e.payload ?? {},
    });
  // Timeline writes must never break the main action, but must be visible.
  if (error) console.error("[portal] event insert failed", { type: e.type, code: error.code });
}

export async function getRecord(
  admin: AdminClient,
  member: ServiceMember,
  def: PortalObjectDef,
  id: string,
): Promise<ServiceResult<PortalRow>> {
  if (!canReadObject(member, def)) return { ok: false, error: FORBIDDEN };
  const { data, error } = await loose(admin)
    .from(def.table)
    .select("*")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, error: "Could not load the record." };
  if (!data) return { ok: false, error: "Record not found." };
  return { ok: true, data: data as PortalRow };
}

export async function createRecord(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  input: unknown,
): Promise<ServiceResult<PortalRow>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  if (!def.allowCreate) return { ok: false, error: `${def.label} records cannot be created here.` };
  const parsed = parsePortalInput(def, "create", input);
  if (!parsed.ok) return parsed;
  const { data, error } = await loose(admin)
    .from(def.table)
    .insert({ ...parsed.values, org_id: member.orgId })
    .select("*")
    .single();
  if (error || !data) return { ok: false, error: friendlyDbError(error ?? {}) };
  const row = data as PortalRow;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.record_created",
    entity: def.key,
    entityId: row.id,
  });
  await addRecordEvent(admin, {
    orgId: member.orgId,
    objectKey: def.key,
    recordId: row.id,
    type: "created",
    actorId: member.userId,
  });
  await emit(member.orgId, "portal.record_created", { object: def.key, record_id: row.id });
  return { ok: true, data: row, message: `${def.label} record created.` };
}

export async function updateRecord(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  id: string,
  input: unknown,
): Promise<ServiceResult<PortalRow>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  const parsed = parsePortalInput(def, "update", input);
  if (!parsed.ok) return parsed;
  const keys = Object.keys(parsed.values);
  if (keys.length === 0) return { ok: false, error: "Nothing to change." };

  const current = await getRecord(admin, member, def, id);
  if (!current.ok) return current;
  const changed = diffRecord(current.data, parsed.values, keys);
  if (Object.keys(changed).length === 0)
    return { ok: true, data: current.data, message: "No changes." };

  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(changed)) patch[k] = parsed.values[k];
  const { data, error } = await loose(admin)
    .from(def.table)
    .update(patch)
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) return { ok: false, error: friendlyDbError(error ?? {}) };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.record_updated",
    entity: def.key,
    entityId: id,
    diff: { fields: Object.keys(changed) },
  });
  await addRecordEvent(admin, {
    orgId: member.orgId,
    objectKey: def.key,
    recordId: id,
    type: "updated",
    actorId: member.userId,
    payload: { changes: changed } as unknown as Json,
  });
  await emit(member.orgId, "portal.record_updated", {
    object: def.key,
    record_id: id,
    fields: Object.keys(changed),
  });
  return { ok: true, data: data as PortalRow, message: "Saved." };
}

export async function deleteRecord(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  id: string,
): Promise<ServiceResult<{ id: string }>> {
  const def = requirePortalObject(objectKey);
  if (!canWriteObject(member, def)) return { ok: false, error: FORBIDDEN };
  if (!def.allowDelete) return { ok: false, error: `${def.label} records cannot be deleted.` };
  const { error, count } = await loose(admin)
    .from(def.table)
    .delete({ count: "exact" })
    .eq("org_id", member.orgId)
    .eq("id", id);
  if (error) return { ok: false, error: friendlyDbError(error) };
  if (!count) return { ok: false, error: "Record not found." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.record_deleted",
    entity: def.key,
    entityId: id,
  });
  await emit(member.orgId, "portal.record_deleted", { object: def.key, record_id: id });
  return { ok: true, data: { id }, message: "Deleted." };
}

/** Display names for link columns: column key → (record id → title). */
export async function resolveLinks(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
  rows: PortalRow[],
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const col of def.columns) {
    if (col.type !== "link" || !col.link) continue;
    const target = requirePortalObject(col.link.object);
    const ids = [
      ...new Set(rows.map((r) => r[col.key]).filter((v): v is string => typeof v === "string")),
    ];
    if (ids.length === 0) {
      out[col.key] = {};
      continue;
    }
    const { data } = await loose(admin)
      .from(target.table)
      .select(`id, ${target.titleColumn}`)
      .eq("org_id", orgId)
      .in("id", ids);
    const map: Record<string, string> = {};
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      map[String(r.id)] = String(r[target.titleColumn] ?? r.id);
    }
    out[col.key] = map;
  }
  return out;
}

/** Options for a link picker: the first rows of the target object by title. */
export async function linkOptions(
  admin: AdminClient,
  orgId: string,
  targetKey: string,
  search = "",
  limit = 50,
): Promise<Array<{ value: string; label: string }>> {
  const target = requirePortalObject(targetKey);
  let q = loose(admin)
    .from(target.table)
    .select(`id, ${target.titleColumn}`)
    .eq("org_id", orgId)
    .order(target.titleColumn, { ascending: true })
    .limit(Math.min(200, limit));
  const s = search.trim();
  if (s) q = q.ilike(target.titleColumn, `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { data } = await q;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    value: String(r.id),
    label: String(r[target.titleColumn] ?? r.id),
  }));
}

// ---------------------------------------------------------------------------
// Comments, timeline, attachments
// ---------------------------------------------------------------------------

export async function addComment(
  admin: AdminClient,
  member: ServiceMember,
  objectKey: string,
  recordId: string,
  rawBody: string,
): Promise<ServiceResult<{ id: string }>> {
  const def = requirePortalObject(objectKey);
  if (!canReadObject(member, def)) return { ok: false, error: FORBIDDEN };
  const { text, userIds } = parseMentions(rawBody.trim());
  if (text.length < 1 || text.length > 5000)
    return { ok: false, error: "Comment must be 1–5000 characters." };

  const exists = await getRecord(admin, member, def, recordId);
  if (!exists.ok) return exists;

  // Only notify active members of this org who can read the object.
  let mentioned: string[] = [];
  if (userIds.length > 0) {
    const { data } = await admin
      .from("memberships")
      .select("user_id, roles(permissions)")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .in("user_id", userIds);
    mentioned = (data ?? [])
      .filter((m) =>
        can(
          {
            userId: m.user_id,
            orgId: member.orgId,
            roleId: "",
            status: "active",
            permissions: ((m.roles?.permissions as unknown[]) ?? []).filter(
              (p): p is string => typeof p === "string",
            ),
          },
          def.readPerm,
        ),
      )
      .map((m) => m.user_id);
  }

  const { data, error } = await loose(admin)
    .from("portal_comments")
    .insert({
      org_id: member.orgId,
      object_key: def.key,
      record_id: recordId,
      author_id: member.userId,
      body: text,
      mentioned_user_ids: mentioned,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not post the comment." };

  await addRecordEvent(admin, {
    orgId: member.orgId,
    objectKey: def.key,
    recordId,
    type: "comment",
    actorId: member.userId,
  });
  for (const uid of mentioned.filter((u) => u !== member.userId)) {
    await createNotification(admin, {
      orgId: member.orgId,
      userId: uid,
      type: "mention",
      title: `You were mentioned on ${def.label}`,
      body: null,
      payload: { object: def.key, record_id: recordId, comment_id: data.id as string },
    });
  }
  return { ok: true, data: { id: data.id as string } };
}

export const PORTAL_BUCKET = "portal-files";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function portalFilePath(
  orgId: string,
  objectKey: string,
  recordId: string,
  uuid: string,
  ext: string,
): string {
  const safeExt = ext
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase();
  return `${orgId}/${objectKey}/${recordId}/${uuid}${safeExt ? `.${safeExt}` : ""}`;
}

/** A path is valid for a record only if it sits under that record's org/object/record prefix. */
export function pathBelongsToRecord(
  path: string,
  orgId: string,
  objectKey: string,
  recordId: string,
): boolean {
  return path.startsWith(`${orgId}/${objectKey}/${recordId}/`) && !path.includes("..");
}
