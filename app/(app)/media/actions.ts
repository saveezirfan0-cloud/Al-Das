"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { assetMetaSchema } from "@/lib/documents/schema";
import { inspectStoredObject } from "@/lib/media/inspect";
import {
  assetUsage,
  listLibraryAssets,
  usageSummary,
  type AssetUsage,
  type LibraryAsset,
} from "@/lib/media/library";
import { validateMedia, type MediaKind } from "@/lib/media/limits";
import { LIBRARY_BUCKET, libraryObjectPath } from "@/lib/media/paths";
import { probeObject, removeObjects } from "@/lib/media/probe";
import { isServable } from "@/lib/media/scan";
import { configuredScanner, scanColumns, scanStored } from "@/lib/media/server";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const DENIED = "You do not have permission for that.";
const PATH = "/media";

/** The library may be browsed with media.view or media.manage; changed only with media.manage. */
async function viewer() {
  const member = await requireMember();
  return can(member, "media.view") || can(member, "media.manage") ? member : null;
}
async function manager() {
  const member = await requireMember();
  return can(member, "media.manage") ? member : null;
}

// ---------------------------------------------------------------------------
// Upload: prepare (row + signed upload URLs) -> browser uploads -> finalise (server checks the stored object)
// ---------------------------------------------------------------------------

const prepareSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mime_type: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
  original_size: z.number().int().positive().nullish(),
  width: z.number().int().positive().max(20000).nullish(),
  height: z.number().int().positive().max(20000).nullish(),
  folder_id: uuid.nullish(),
  tags: z.array(z.string()).max(10).default([]),
  /** The browser also made a small JPEG preview to upload next to an image. */
  with_thumb: z.boolean().default(false),
});

export type PreparedUpload = {
  asset_id: string;
  upload: { path: string; token: string };
  thumb: { path: string; token: string } | null;
};

export async function prepareLibraryUpload(
  input: z.input<typeof prepareSchema>,
): Promise<ActionResult<PreparedUpload>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const parsed = prepareSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const v = parsed.data;
  const check = validateMedia({ mime: v.mime_type, size: v.size }, "library");
  if (!check.ok) return fail(check.message);
  if (check.kind === "patient_document") return fail("That type cannot go in the library.");
  const meta = assetMetaSchema.safeParse({
    name: v.name,
    folder_id: v.folder_id ?? null,
    tags: v.tags,
  });
  if (!meta.success) return fail(meta.error.issues[0]?.message ?? "Invalid name or tags");

  const admin = createAdminClient(member.userId);
  if (v.folder_id) {
    const { data: folder } = await admin
      .from("media_folders")
      .select("id")
      .eq("id", v.folder_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!folder) return fail("That folder does not exist.");
  }
  const assetId = randomUUID();
  const path = libraryObjectPath(member.orgId, assetId, "original", check.extension);
  const wantThumb = v.with_thumb && check.kind === "image";
  const thumbPath = wantThumb ? libraryObjectPath(member.orgId, assetId, "thumb") : null;
  const { error } = await admin.from("media_assets").insert({
    id: assetId,
    org_id: member.orgId,
    folder_id: v.folder_id ?? null,
    name: meta.data.name,
    kind: check.kind,
    mime_type: check.mime,
    size_bytes: v.size,
    original_size_bytes: v.original_size ?? null,
    width: v.width ?? null,
    height: v.height ?? null,
    storage_path: path,
    tags: meta.data.tags,
    uploaded_by: member.userId,
  });
  if (error) return fail("Could not start the upload.");

  const store = admin.storage.from(LIBRARY_BUCKET);
  const main = await store.createSignedUploadUrl(path);
  const thumb = thumbPath ? await store.createSignedUploadUrl(thumbPath) : null;
  if (main.error || !main.data) {
    await admin.from("media_assets").delete().eq("id", assetId);
    return fail("Could not prepare the upload.");
  }
  return {
    ok: true,
    data: {
      asset_id: assetId,
      upload: { path: main.data.path, token: main.data.token },
      thumb: thumb?.data ? { path: thumb.data.path, token: thumb.data.token } : null,
    },
  };
}

async function loadOwnAsset(member: { orgId: string }, id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("media_assets")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return { admin, asset: data };
}

/** Checks what the browser actually stored (size, content, scan) and only then makes the file visible. */
export async function finalizeLibraryUpload(
  assetId: string,
): Promise<ActionResult<{ id: string }>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(assetId).success) return fail("Invalid input");
  const { admin, asset } = await loadOwnAsset(member, assetId);
  if (!asset) return fail("That upload was not found.");
  if (asset.status === "ready") return { ok: true, data: { id: asset.id } };

  const reject = async (message: string) => {
    await removeObjects(admin, LIBRARY_BUCKET, [
      asset.storage_path,
      libraryObjectPath(member.orgId, asset.id, "thumb"),
    ]);
    await admin.from("media_assets").delete().eq("id", asset.id).eq("status", "pending");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "media.upload_rejected",
      entity: "media_asset",
      entityId: asset.id,
      diff: { reason: message.slice(0, 120) } as Json,
    });
    return fail(message);
  };

  const stored = await probeObject(admin, LIBRARY_BUCKET, asset.storage_path);
  if (!stored) return reject("The file did not arrive. Please try again.");
  const verdict = inspectStoredObject(
    { declaredMime: asset.mime_type, purpose: "library", expect: asset.kind as MediaKind },
    stored,
  );
  if (!verdict.ok) return reject(verdict.message);

  // The optional preview must be a real JPEG, otherwise it is dropped (the original is shown instead).
  let thumbPath: string | null = null;
  if (asset.kind === "image") {
    const candidate = libraryObjectPath(member.orgId, asset.id, "thumb");
    const t = await probeObject(admin, LIBRARY_BUCKET, candidate);
    if (t && t.size <= 512 * 1024 && t.head[0] === 0xff && t.head[1] === 0xd8)
      thumbPath = candidate;
    else if (t) await removeObjects(admin, LIBRARY_BUCKET, [candidate]);
  }

  const scan = await scanStored(admin, {
    bucket: LIBRARY_BUCKET,
    path: asset.storage_path,
    size: stored.size,
    mime: verdict.mime,
  });
  const { error } = await admin
    .from("media_assets")
    .update({
      status: "ready",
      size_bytes: stored.size,
      mime_type: verdict.mime,
      thumb_path: thumbPath,
      ...scanColumns(scan),
    })
    .eq("id", asset.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the file.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.uploaded",
    entity: "media_asset",
    entityId: asset.id,
    diff: {
      kind: asset.kind,
      size_bytes: stored.size,
      original_size_bytes: asset.original_size_bytes,
      scan_status: scan.verdict,
    } as Json,
  });
  revalidatePath(PATH);
  return {
    ok: true,
    data: { id: asset.id },
    message:
      scan.verdict === "infected"
        ? "Uploaded, but the malware scan blocked this file."
        : scan.verdict === "unscanned"
          ? "Uploaded. No malware scanner is configured, so the file is marked not scanned."
          : "Uploaded.",
  };
}

/** The browser gave up (or the upload failed): drop the half-made row and any bytes. */
export async function abandonLibraryUpload(assetId: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(assetId).success) return fail("Invalid input");
  const { admin, asset } = await loadOwnAsset(member, assetId);
  if (!asset || asset.status !== "pending") return { ok: true };
  await removeObjects(admin, LIBRARY_BUCKET, [
    asset.storage_path,
    libraryObjectPath(member.orgId, asset.id, "thumb"),
  ]);
  await admin.from("media_assets").delete().eq("id", asset.id).eq("status", "pending");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.upload_cancelled",
    entity: "media_asset",
    entityId: asset.id,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Organise
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  id: uuid,
  name: z.string(),
  folder_id: uuid.nullable(),
  tags: z.array(z.string()),
});

export async function updateAsset(input: z.input<typeof updateSchema>): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const p = updateSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  const meta = assetMetaSchema.safeParse({
    name: p.data.name,
    folder_id: p.data.folder_id,
    tags: p.data.tags,
  });
  if (!meta.success) return fail(meta.error.issues[0]?.message ?? "Invalid name or tags");
  const { admin, asset } = await loadOwnAsset(member, p.data.id);
  if (!asset || asset.status !== "ready") return fail("File not found.");
  if (meta.data.folder_id) {
    const { data: folder } = await admin
      .from("media_folders")
      .select("id")
      .eq("id", meta.data.folder_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!folder) return fail("That folder does not exist.");
  }
  const { error } = await admin
    .from("media_assets")
    .update({ name: meta.data.name, folder_id: meta.data.folder_id ?? null, tags: meta.data.tags })
    .eq("id", asset.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the changes.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.updated",
    entity: "media_asset",
    entityId: asset.id,
    diff: {
      renamed: asset.name !== meta.data.name,
      moved: (asset.folder_id ?? null) !== (meta.data.folder_id ?? null),
      tags: meta.data.tags.length,
    } as Json,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Saved." };
}

export async function deleteAsset(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, asset } = await loadOwnAsset(member, id);
  if (!asset) return fail("File not found.");
  const usage = await assetUsage(admin, member.orgId, asset.id);
  if (usage.some((u) => u.blocking))
    return fail(`This file cannot be deleted. ${usageSummary(usage)} Remove it there first.`);
  // The database re-checks (a trigger) in case something started using the file a moment ago.
  const { error } = await admin
    .from("media_assets")
    .delete()
    .eq("id", asset.id)
    .eq("org_id", member.orgId);
  if (error) {
    return fail(
      error.code === "23001" || error.code === "23503"
        ? "This file is in use and cannot be deleted."
        : "Could not delete the file.",
    );
  }
  const ok = await removeObjects(admin, LIBRARY_BUCKET, [
    asset.storage_path,
    ...(asset.thumb_path ? [asset.thumb_path] : []),
  ]);
  if (!ok) console.error("[media] storage removal failed after delete", { asset: asset.id });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.deleted",
    entity: "media_asset",
    entityId: asset.id,
    diff: { kind: asset.kind, size_bytes: asset.size_bytes, files_removed: ok } as Json,
  });
  revalidatePath(PATH);
  return { ok: true, message: "File deleted." };
}

const folderName = z.string().trim().min(1, "Name the folder.").max(60);

export async function createFolder(name: string): Promise<ActionResult<{ id: string }>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const n = folderName.safeParse(name);
  if (!n.success) return fail(n.error.issues[0]?.message ?? "Invalid name");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("media_folders")
    .insert({ org_id: member.orgId, name: n.data, created_by: member.userId })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      error?.code === "23505" ? "A folder with that name exists." : "Could not create the folder.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.folder_created",
    entity: "media_folder",
    entityId: data.id,
  });
  revalidatePath(PATH);
  return { ok: true, data: { id: data.id } };
}

export async function renameFolder(id: string, name: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const n = folderName.safeParse(name);
  if (!uuid.safeParse(id).success || !n.success)
    return fail(n.success ? "Invalid input" : (n.error.issues[0]?.message ?? "Invalid name"));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("media_folders")
    .update({ name: n.data })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error)
    return fail(
      error.code === "23505" ? "A folder with that name exists." : "Could not rename the folder.",
    );
  if (!data?.length) return fail("Folder not found.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.folder_renamed",
    entity: "media_folder",
    entityId: id,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/** Deleting a folder keeps its files: they move to "Unfiled". */
export async function deleteFolder(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("media_folders")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error) return fail("Could not delete the folder.");
  if (!data?.length) return fail("Folder not found.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "media.folder_deleted",
    entity: "media_folder",
    entityId: id,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Folder deleted. Its files are now unfiled." };
}

// ---------------------------------------------------------------------------
// Reading: links, usage, the picker
// ---------------------------------------------------------------------------

/** A 5-minute link to preview or download a library file. */
export async function getAssetUrl(
  id: string,
  download = false,
): Promise<ActionResult<{ url: string; kind: string }>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, asset } = await loadOwnAsset(member, id);
  if (!asset || asset.status !== "ready") return fail("File not found.");
  if (!isServable(asset.scan_status)) return fail("The malware scan blocked this file.");
  const { data, error } = await admin.storage
    .from(LIBRARY_BUCKET)
    .createSignedUrl(asset.storage_path, 300, download ? { download: true } : undefined);
  if (error || !data) return fail("Could not open the file.");
  return { ok: true, data: { url: data.signedUrl, kind: asset.kind } };
}

export async function getAssetUsage(id: string): Promise<ActionResult<AssetUsage[]>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const admin = createAdminClient();
  const { data: asset } = await admin
    .from("media_assets")
    .select("id")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!asset) return fail("File not found.");
  return { ok: true, data: await assetUsage(admin, member.orgId, id) };
}

const pickerSchema = z.object({
  kind: z.enum(["image", "video", "document"]).nullish(),
  q: z.string().max(60).nullish(),
  /** Restrict to the types Meta accepts in a template header. */
  mimes: z.array(z.string().max(100)).max(10).nullish(),
});

/** Files for the "choose from the library" dialogs. Blocked (infected) files are left out. */
export async function listPickerAssets(
  input: z.input<typeof pickerSchema>,
): Promise<ActionResult<LibraryAsset[]>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  const p = pickerSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  const admin = createAdminClient();
  const { assets } = await listLibraryAssets(admin, member.orgId, {
    kind: p.data.kind ?? null,
    q: p.data.q ?? null,
    mimes: p.data.mimes ?? null,
    limit: 60,
  });
  return { ok: true, data: assets.filter((a) => isServable(a.scan_status)) };
}

/** Runs the malware scanner again over one file (after a provider has been configured, or after an error). */
export async function rescanAsset(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, asset } = await loadOwnAsset(member, id);
  if (!asset || asset.status !== "ready") return fail("File not found.");
  const scanner = configuredScanner();
  if (scanner.name === "none")
    return fail("No malware scanner is configured, so there is nothing to scan with.");
  try {
    const scan = await scanStored(
      admin,
      {
        bucket: LIBRARY_BUCKET,
        path: asset.storage_path,
        size: asset.size_bytes,
        mime: asset.mime_type,
      },
      scanner,
    );
    await admin
      .from("media_assets")
      .update(scanColumns(scan))
      .eq("id", asset.id)
      .eq("org_id", member.orgId);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "media.rescanned",
      entity: "media_asset",
      entityId: asset.id,
      diff: { scan_status: scan.verdict } as Json,
    });
    revalidatePath(PATH);
    return { ok: true, message: `Scan result: ${scan.verdict}.` };
  } catch (err) {
    console.error("[media] rescan failed", { error: redactText(err) });
    return fail("The scan could not run.");
  }
}
