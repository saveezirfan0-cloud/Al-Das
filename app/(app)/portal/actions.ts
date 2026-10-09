"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { filterSchema } from "@/lib/filters/ast";
import { requireMember } from "@/lib/auth/session";
import { loose } from "@/lib/portal/db";
import { countPortal, queryPortal, MAX_PAGE_SIZE } from "@/lib/portal/query";
import { canReadObject, canWriteObject } from "@/lib/portal/permissions";
import {
  addComment,
  addRecordEvent,
  createRecord,
  deleteRecord,
  getRecord,
  MAX_ATTACHMENT_BYTES,
  PORTAL_BUCKET,
  pathBelongsToRecord,
  portalFilePath,
  resolveLinks,
  updateRecord,
} from "@/lib/portal/service";
import { loadPortalRegistry, resolveEnabledObject } from "@/lib/portal/server";
import type { PortalObjectDef, PortalRow } from "@/lib/portal/types";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.string().uuid();
const objectKey = z.string().regex(/^[a-z][a-z0-9_]{0,48}$/);

/** Resolves the object, enforcing org enablement and the read permission. */
async function readable(key: string) {
  const member = await requireMember();
  const admin = createAdminClient();
  const k = objectKey.safeParse(key);
  const def = k.success ? await resolveEnabledObject(admin, member.orgId, k.data) : null;
  if (!def || !canReadObject(member, def)) return { member, admin, def: null as null };
  return { member, admin, def: def as PortalObjectDef };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const listSchema = z.object({
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  sort: z
    .array(z.object({ field: z.string().max(80), dir: z.enum(["asc", "desc"]) }))
    .max(3)
    .optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});

export async function listRecords(
  key: string,
  input: z.input<typeof listSchema>,
): Promise<
  ActionResult<{
    rows: PortalRow[];
    total: number;
    links: Record<string, Record<string, string>>;
  }>
> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    const { registry } = await loadPortalRegistry(admin, member.orgId, def);
    const page = await queryPortal(
      admin,
      {
        orgId: member.orgId,
        def,
        filter: parsed.data.filter,
        search: parsed.data.search,
        sort: parsed.data.sort,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        timezone: member.org.timezone,
      },
      registry,
    );
    const links = await resolveLinks(admin, member.orgId, def, page.rows);
    return { ok: true, data: { rows: page.rows, total: page.total, links } };
  } catch (err) {
    // Unknown field / operator errors from the filter compiler are user-fixable.
    return fail(
      err instanceof Error && /filter|field|operator|sortable/i.test(err.message)
        ? err.message
        : "Could not load the list.",
    );
  }
}

export async function previewFilterCount(
  key: string,
  filter: z.input<typeof filterSchema>,
): Promise<ActionResult<{ count: number }>> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) return fail("Invalid filter");
  try {
    const { registry } = await loadPortalRegistry(admin, member.orgId, def);
    const count = await countPortal(
      admin,
      member.orgId,
      def,
      registry,
      parsed.data,
      member.org.timezone,
    );
    return { ok: true, data: { count } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not count.");
  }
}

// ---------------------------------------------------------------------------
// Record drawer
// ---------------------------------------------------------------------------

export type RecordDetail = {
  row: PortalRow;
  links: Record<string, Record<string, string>>;
  events: Array<{
    id: number;
    type: string;
    actorId: string | null;
    payload: unknown;
    createdAt: string;
  }>;
  comments: Array<{ id: string; authorId: string | null; body: string; createdAt: string }>;
  attachments: Array<{
    id: string;
    fileName: string;
    contentType: string | null;
    sizeBytes: number | null;
    uploadedBy: string | null;
    createdAt: string;
  }>;
};

export async function getRecordDetail(
  key: string,
  id: string,
): Promise<ActionResult<RecordDetail>> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  if (!uuid.safeParse(id).success) return fail("Invalid record.");
  const rec = await getRecord(admin, member, def, id);
  if (!rec.ok) return fail(rec.error);
  const l = loose(admin);
  const [links, events, comments, attachments] = await Promise.all([
    resolveLinks(admin, member.orgId, def, [rec.data]),
    l
      .from("portal_record_events")
      .select("id, type, actor_id, payload, created_at")
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .eq("record_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    l
      .from("portal_comments")
      .select("id, author_id, body, created_at")
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .eq("record_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    l
      .from("portal_attachments")
      .select("id, file_name, content_type, size_bytes, uploaded_by, created_at")
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .eq("record_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  type Row = Record<string, unknown>;
  return {
    ok: true,
    data: {
      row: rec.data,
      links,
      events: ((events.data ?? []) as Row[]).map((e) => ({
        id: e.id as number,
        type: e.type as string,
        actorId: (e.actor_id as string) ?? null,
        payload: e.payload,
        createdAt: e.created_at as string,
      })),
      comments: ((comments.data ?? []) as Row[]).map((c) => ({
        id: c.id as string,
        authorId: (c.author_id as string) ?? null,
        body: c.body as string,
        createdAt: c.created_at as string,
      })),
      attachments: ((attachments.data ?? []) as Row[]).map((a) => ({
        id: a.id as string,
        fileName: a.file_name as string,
        contentType: (a.content_type as string) ?? null,
        sizeBytes: (a.size_bytes as number) ?? null,
        uploadedBy: (a.uploaded_by as string) ?? null,
        createdAt: a.created_at as string,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Create / update / delete (all through lib/portal/service, which re-checks permission + Zod)
// ---------------------------------------------------------------------------

async function writableContext(key: string) {
  const member = await requireMember();
  const admin = createAdminClient();
  const k = objectKey.safeParse(key);
  const def = k.success ? await resolveEnabledObject(admin, member.orgId, k.data) : null;
  return { member, admin, def };
}

export async function createPortalRecord(
  key: string,
  values: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  const { member, admin, def } = await writableContext(key);
  if (!def) return fail("Unknown object.");
  const res = await createRecord(admin, member, def.key, values);
  if (!res.ok) return res;
  revalidatePath(`/portal/${def.key}`);
  return { ok: true, data: { id: res.data.id }, message: res.message };
}

export async function updatePortalRecord(
  key: string,
  id: string,
  values: Record<string, unknown>,
): Promise<ActionResult<PortalRow>> {
  const { member, admin, def } = await writableContext(key);
  if (!def) return fail("Unknown object.");
  if (!uuid.safeParse(id).success) return fail("Invalid record.");
  const res = await updateRecord(admin, member, def.key, id, values);
  if (!res.ok) return res;
  revalidatePath(`/portal/${def.key}`);
  return res;
}

export async function deletePortalRecord(
  key: string,
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { member, admin, def } = await writableContext(key);
  if (!def) return fail("Unknown object.");
  if (!uuid.safeParse(id).success) return fail("Invalid record.");
  const res = await deleteRecord(admin, member, def.key, id);
  if (!res.ok) return res;
  revalidatePath(`/portal/${def.key}`);
  return res;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function postComment(
  key: string,
  recordId: string,
  body: string,
): Promise<ActionResult<{ id: string }>> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  if (!uuid.safeParse(recordId).success) return fail("Invalid record.");
  return addComment(admin, member, def.key, recordId, body);
}

// ---------------------------------------------------------------------------
// Attachments: server-signed upload → browser uploads → register metadata
// ---------------------------------------------------------------------------

const uploadSchema = z.object({
  recordId: uuid,
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().max(120).optional(),
  sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES, "Files can be at most 25 MB."),
});

export async function createPortalUpload(
  key: string,
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const { member, admin, def } = await readable(key);
  if (!def || !canWriteObject(member, def))
    return fail("You do not have permission to attach files.");
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const rec = await getRecord(admin, member, def, parsed.data.recordId);
  if (!rec.ok) return fail(rec.error);
  const ext = parsed.data.fileName.includes(".") ? parsed.data.fileName.split(".").pop()! : "";
  const path = portalFilePath(member.orgId, def.key, parsed.data.recordId, randomUUID(), ext);
  const { data, error } = await admin.storage.from(PORTAL_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return fail("Could not prepare the upload.");
  return { ok: true, data: { path: data.path, token: data.token } };
}

const registerSchema = uploadSchema.extend({ path: z.string().min(1).max(500) });

export async function registerPortalAttachment(
  key: string,
  input: z.input<typeof registerSchema>,
): Promise<ActionResult<{ id: string }>> {
  const { member, admin, def } = await readable(key);
  if (!def || !canWriteObject(member, def))
    return fail("You do not have permission to attach files.");
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  if (!pathBelongsToRecord(d.path, member.orgId, def.key, d.recordId))
    return fail("Invalid attachment path.");
  const { data, error } = await loose(admin)
    .from("portal_attachments")
    .insert({
      org_id: member.orgId,
      object_key: def.key,
      record_id: d.recordId,
      path: d.path,
      file_name: d.fileName,
      content_type: d.contentType ?? null,
      size_bytes: d.sizeBytes,
      uploaded_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return fail("Could not save the attachment.");
  await addRecordEvent(admin, {
    orgId: member.orgId,
    objectKey: def.key,
    recordId: d.recordId,
    type: "attachment",
    actorId: member.userId,
    payload: { file_name: d.fileName },
  });
  return { ok: true, data: { id: data.id as string } };
}

export async function portalAttachmentUrl(
  key: string,
  attachmentId: string,
): Promise<ActionResult<{ url: string }>> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  if (!uuid.safeParse(attachmentId).success) return fail("Invalid attachment.");
  const { data } = await loose(admin)
    .from("portal_attachments")
    .select("path, file_name")
    .eq("org_id", member.orgId)
    .eq("object_key", def.key)
    .eq("id", attachmentId)
    .maybeSingle();
  if (!data) return fail("Attachment not found.");
  const { data: signed, error } = await admin.storage
    .from(PORTAL_BUCKET)
    .createSignedUrl(data.path as string, 300, { download: data.file_name as string });
  if (error || !signed) return fail("Could not open the attachment.");
  return { ok: true, data: { url: signed.signedUrl } };
}

export async function deletePortalAttachment(
  key: string,
  attachmentId: string,
): Promise<ActionResult> {
  const { member, admin, def } = await readable(key);
  if (!def || !canWriteObject(member, def))
    return fail("You do not have permission to remove attachments.");
  if (!uuid.safeParse(attachmentId).success) return fail("Invalid attachment.");
  const l = loose(admin);
  const { data } = await l
    .from("portal_attachments")
    .select("path, record_id")
    .eq("org_id", member.orgId)
    .eq("object_key", def.key)
    .eq("id", attachmentId)
    .maybeSingle();
  if (!data) return fail("Attachment not found.");
  await admin.storage.from(PORTAL_BUCKET).remove([data.path as string]);
  await l.from("portal_attachments").delete().eq("org_id", member.orgId).eq("id", attachmentId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.attachment_deleted",
    entity: def.key,
    entityId: data.record_id as string,
  });
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Saved views and per-user grid layout
// ---------------------------------------------------------------------------

const viewSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, "Name the view").max(80),
  filter: filterSchema.nullable().optional(),
  columns: z
    .array(
      z.object({
        id: z.string().max(80),
        width: z.number().int().min(40).max(1200).optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .max(100)
    .default([]),
  sort: z
    .array(z.object({ field: z.string().max(80), dir: z.enum(["asc", "desc"]) }))
    .max(3)
    .default([]),
  sharedAll: z.boolean().default(false),
  sharedTeamIds: z.array(uuid).max(50).default([]),
});

export async function savePortalView(
  key: string,
  input: z.input<typeof viewSchema>,
): Promise<ActionResult<{ id: string }>> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const v = parsed.data;
  // Sharing makes a view visible to colleagues; only people who can edit the object share.
  if ((v.sharedAll || v.sharedTeamIds.length > 0) && !canWriteObject(member, def))
    return fail("You can save private views only.");
  const row = {
    org_id: member.orgId,
    object_key: def.key,
    owner_id: member.userId,
    name: v.name,
    filter: v.filter ?? {},
    columns: v.columns,
    sort: v.sort,
    shared_all: v.sharedAll,
    shared_team_ids: v.sharedTeamIds,
  };
  const l = loose(admin);
  if (v.id) {
    const { data, error } = await l
      .from("saved_views")
      .update(row)
      .eq("org_id", member.orgId)
      .eq("object_key", def.key)
      .eq("id", v.id)
      .eq("owner_id", member.userId) // owners edit their own views only
      .select("id")
      .maybeSingle();
    if (error || !data) return fail("Could not update the view.");
    return { ok: true, data: { id: data.id as string }, message: "View updated." };
  }
  const { data, error } = await l.from("saved_views").insert(row).select("id").single();
  if (error || !data) return fail("Could not save the view.");
  return { ok: true, data: { id: data.id as string }, message: "View saved." };
}

export async function deletePortalView(key: string, id: string): Promise<ActionResult> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  if (!uuid.safeParse(id).success) return fail("Invalid view.");
  const { data, error } = await loose(admin)
    .from("saved_views")
    .delete()
    .eq("org_id", member.orgId)
    .eq("object_key", def.key)
    .eq("id", id)
    .eq("owner_id", member.userId)
    .select("id");
  if (error || !data || data.length === 0) return fail("Only the owner can delete a view.");
  return { ok: true, data: undefined, message: "View deleted." };
}

const gridPrefsSchema = z.object({
  columns: z
    .array(
      z.object({
        id: z.string().max(80),
        width: z.number().int().min(40).max(1200).optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .max(100),
  pageSize: z.number().int().min(10).max(500).optional(),
});

export async function savePortalGridPrefs(
  key: string,
  prefs: z.input<typeof gridPrefsSchema>,
): Promise<ActionResult> {
  const { member, admin, def } = await readable(key);
  if (!def) return fail("You do not have access to this object.");
  const parsed = gridPrefsSchema.safeParse(prefs);
  if (!parsed.success) return fail("Invalid preferences");
  const { error } = await admin.from("user_grid_prefs").upsert(
    {
      org_id: member.orgId,
      user_id: member.userId,
      grid_key: `portal_${def.key}`,
      prefs: parsed.data as never,
    },
    { onConflict: "org_id,user_id,grid_key" },
  );
  if (error) return fail("Could not save the layout.");
  return { ok: true, data: undefined };
}
