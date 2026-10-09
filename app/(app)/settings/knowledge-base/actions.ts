"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { aiSettingsSchema, readAiSettings, writeAiSettings } from "@/lib/ai/settings";
import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { enqueue } from "@/lib/jobs/enqueue";
import { assertPublicHttpsUrl, UnsafeUrlError } from "@/lib/net/url-guard";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };
type UploadResult =
  | { ok: true; data: { path: string; token: string } }
  | { ok: false; error: string };

const uuid = z.string().uuid();
const PATH = "/settings/knowledge-base";
const KB_BUCKET = "kb-files";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_EXTENSIONS = ["pdf", "txt", "md", "markdown", "html", "htm", "csv"];

function fail(error: string): ActionResult {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// AI switch (settings.manage: it decides whether conversation text leaves the platform)
// ---------------------------------------------------------------------------

export async function saveAiSettings(input: z.input<typeof aiSettingsSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = aiSettingsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const admin = createAdminClient();

  // Groups must be this org's.
  if (parsed.data.kb_group_ids.length) {
    const { data } = await admin.from("kb_groups").select("id").eq("org_id", member.orgId).in("id", parsed.data.kb_group_ids);
    if ((data?.length ?? 0) !== parsed.data.kb_group_ids.length) return fail("One of the selected groups no longer exists.");
  }

  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readAiSettings(org?.settings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeAiSettings(org?.settings, parsed.data) as never })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the AI settings.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "ai.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { enabled: [before.enabled, parsed.data.enabled], rate_limit_per_minute: parsed.data.rate_limit_per_minute },
  });
  revalidatePath(PATH);
  revalidatePath("/inbox");
  return { ok: true, message: parsed.data.enabled ? "AI assist is on." : "AI assist is off." };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const groupSchema = z.object({
  name: z.string().trim().min(1, "Give the group a name.").max(80),
  description: z.string().trim().max(300).optional(),
});

export async function createGroup(input: z.input<typeof groupSchema>): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kb_groups")
    .insert({ org_id: member.orgId, name: parsed.data.name, description: parsed.data.description || null })
    .select("id")
    .single();
  if (error) return fail(error.code === "23505" ? "A group with that name already exists." : "Could not create the group.");
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "kb.group_created", entity: "kb_group", entityId: data.id });
  revalidatePath(PATH);
  return { ok: true, message: "Group created." };
}

export async function deleteGroup(id: string): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const admin = createAdminClient();
  const { error } = await admin.from("kb_groups").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return fail("Could not delete the group.");
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "kb.group_deleted", entity: "kb_group", entityId: id });
  revalidatePath(PATH);
  return { ok: true, message: "Group deleted. Its sources are kept, now ungrouped." };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function ownGroup(orgId: string, groupId: string | null | undefined): Promise<boolean> {
  if (!groupId) return true;
  const { data } = await createAdminClient().from("kb_groups").select("id").eq("id", groupId).eq("org_id", orgId).maybeSingle();
  return !!data;
}

const urlSourceSchema = z.object({
  url: z.string().trim().min(1, "Enter a URL.").max(2000),
  name: z.string().trim().max(200).optional(),
  group_id: uuid.nullable().optional(),
});

export async function addUrlSource(input: z.input<typeof urlSourceSchema>): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  const parsed = urlSourceSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  let url: URL;
  try {
    url = await assertPublicHttpsUrl(parsed.data.url); // https only, public addresses only (SSRF guard)
  } catch (err) {
    return fail(err instanceof UnsafeUrlError ? err.message : "Enter a valid URL.");
  }
  if (!(await ownGroup(member.orgId, parsed.data.group_id))) return fail("That group no longer exists.");

  const admin = createAdminClient();
  const { data: dupe } = await admin.from("kb_sources").select("id").eq("org_id", member.orgId).eq("url", url.toString()).maybeSingle();
  if (dupe) return fail("That URL is already in the knowledge base.");

  const { data, error } = await admin
    .from("kb_sources")
    .insert({
      org_id: member.orgId,
      group_id: parsed.data.group_id ?? null,
      kind: "url",
      name: parsed.data.name || `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200),
      url: url.toString(),
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error) return fail("Could not add the source.");
  await enqueue("kb_ingest", { source_id: data.id });
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "kb.source_added", entity: "kb_source", entityId: data.id, diff: { kind: "url", host: url.hostname } });
  revalidatePath(PATH);
  return { ok: true, message: "Source added. It will be ready in a minute." };
}

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive(),
});

function safeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120) || "file";
}

/** Signed upload URL so the browser uploads straight to Storage (no server body limit). */
export async function prepareKbUpload(input: z.input<typeof uploadSchema>): Promise<UploadResult> {
  const member = await requirePerm("kb.manage");
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const ext = parsed.data.filename.split(".").pop()?.toLowerCase() ?? "";
  if (!FILE_EXTENSIONS.includes(ext)) return { ok: false, error: `Use one of: ${FILE_EXTENSIONS.join(", ")}.` };
  if (parsed.data.size > MAX_FILE_BYTES) return { ok: false, error: "Files can be up to 20 MB." };

  const path = `${member.orgId}/${randomUUID()}/${safeFilename(parsed.data.filename)}`;
  const { data, error } = await createAdminClient().storage.from(KB_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Could not prepare the upload." };
  return { ok: true, data: { path: data.path, token: data.token } };
}

const fileSourceSchema = z.object({
  path: z.string().min(1).max(500),
  mime_type: z.string().trim().max(100).optional(),
  name: z.string().trim().max(200).optional(),
  group_id: uuid.nullable().optional(),
});

export async function addFileSource(input: z.input<typeof fileSourceSchema>): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  const parsed = fileSourceSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  // The path must be one we issued for this org.
  if (!parsed.data.path.startsWith(`${member.orgId}/`) || parsed.data.path.includes("..")) return fail("Invalid upload.");
  if (!(await ownGroup(member.orgId, parsed.data.group_id))) return fail("That group no longer exists.");

  const filename = parsed.data.path.split("/").pop() ?? "file";
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kb_sources")
    .insert({
      org_id: member.orgId,
      group_id: parsed.data.group_id ?? null,
      kind: "file",
      name: parsed.data.name || filename,
      storage_path: parsed.data.path,
      mime_type: parsed.data.mime_type || null,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error) return fail("Could not add the file.");
  await enqueue("kb_ingest", { source_id: data.id });
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "kb.source_added", entity: "kb_source", entityId: data.id, diff: { kind: "file" } });
  revalidatePath(PATH);
  return { ok: true, message: "File added. It will be ready in a minute." };
}

export async function recrawlSource(id: string): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kb_sources")
    .update({ status: "pending", error: null })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("Source not found.");
  await enqueue("kb_ingest", { source_id: data.id });
  revalidatePath(PATH);
  return { ok: true, message: "Re-crawl queued." };
}

export async function setSourceGroup(id: string, groupId: string | null): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  if (!uuid.safeParse(id).success || (groupId !== null && !uuid.safeParse(groupId).success)) return fail("Invalid input");
  if (!(await ownGroup(member.orgId, groupId))) return fail("That group no longer exists.");
  const { error } = await createAdminClient().from("kb_sources").update({ group_id: groupId }).eq("id", id).eq("org_id", member.orgId);
  if (error) return fail("Could not move the source.");
  revalidatePath(PATH);
  return { ok: true, message: "Source moved." };
}

export async function deleteSource(id: string): Promise<ActionResult> {
  const member = await requirePerm("kb.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const admin = createAdminClient();
  const { data: source } = await admin
    .from("kb_sources")
    .select("id, kind, storage_path")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!source) return fail("Source not found.");
  const { error } = await admin.from("kb_sources").delete().eq("id", id).eq("org_id", member.orgId); // chunks cascade
  if (error) return fail("Could not delete the source.");
  if (source.kind === "file" && source.storage_path) await admin.storage.from(KB_BUCKET).remove([source.storage_path]);
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "kb.source_deleted", entity: "kb_source", entityId: id });
  revalidatePath(PATH);
  return { ok: true, message: "Source deleted." };
}
