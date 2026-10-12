"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { unknownVariables } from "@/lib/inbox/quick-reply";
import { canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { inboxSettingsSchema, writeInboxSettings, type InboxSettings } from "@/lib/inbox/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { LABEL_COLORS } from "@/lib/inbox/labels";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PATHS = ["/settings/inbox", "/inbox"];
function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

export async function saveInboxSettings(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = inboxSettingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const admin = createAdminClient();
  if (parsed.data.default_team_id) {
    const { data: team } = await admin
      .from("teams")
      .select("id")
      .eq("id", parsed.data.default_team_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!team) return { ok: false, error: "That team does not exist." };
  }
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const next = writeInboxSettings(org?.settings, parsed.data as InboxSettings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save settings." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "inbox.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: parsed.data as Json,
  });
  revalidate();
  return { ok: true, message: "Inbox settings saved." };
}

// --- Categories -------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(60);

export async function addCategory(name: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const n = nameSchema.safeParse(name);
  if (!n.success) return { ok: false, error: "Enter a name." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("conv_categories")
    .insert({ org_id: member.orgId, name: n.data });
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505" ? "That category already exists." : "Could not add the category.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "inbox_category.created",
    entity: "inbox_category",
    entityId: null,
    diff: { name: n.data },
  });
  revalidate();
  return { ok: true, message: "Category added." };
}

export async function deleteCategory(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("conv_categories")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the category." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "inbox_category.deleted",
    entity: "inbox_category",
    entityId: id,
  });
  revalidate();
  return { ok: true, message: "Category deleted." };
}

// --- Quick replies -----------------------------------------------------------

const quickReplySchema = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,40}$/, "Shortcut: letters, numbers, - and _ only"),
  text: z.string().trim().min(1).max(4096),
  text_ar: z.string().trim().max(4096).optional(),
  /** A Media Library file sent together with the text. */
  media_asset_id: z.string().uuid().nullish(),
});

export async function saveQuickReply(
  id: string | null,
  input: { shortcut: string; text: string; text_ar?: string; media_asset_id?: string | null },
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = quickReplySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  if (parsed.data.media_asset_id) {
    if (!canAny(member, ["media.view", "media.manage"]))
      return { ok: false, error: "You don't have access to the Media Library." };
    const { data: asset } = await admin
      .from("media_assets")
      .select("id, kind, status, scan_status")
      .eq("id", parsed.data.media_asset_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!asset || asset.status !== "ready")
      return { ok: false, error: "That library file no longer exists." };
    if (asset.scan_status === "infected")
      return { ok: false, error: "The malware scan blocked that file." };
  }
  // A variable name nobody supports is almost always a typo ({{docter}}): say so instead of sending it to patients.
  const unknown = [
    ...unknownVariables(parsed.data.text),
    ...unknownVariables(parsed.data.text_ar ?? ""),
  ];
  if (unknown.length)
    return {
      ok: false,
      error: `Unknown variable${unknown.length === 1 ? "" : "s"}: ${[...new Set(unknown)].map((v) => `{{${v}}}`).join(", ")}`,
    };
  const row = {
    org_id: member.orgId,
    shortcut: parsed.data.shortcut,
    text: parsed.data.text,
    text_ar: parsed.data.text_ar || null,
    media_asset_id: parsed.data.media_asset_id ?? null,
    created_by: member.userId,
  };
  const { error } = id
    ? await admin
        .from("quick_replies")
        .update({
          shortcut: row.shortcut,
          text: row.text,
          text_ar: row.text_ar,
          media_asset_id: row.media_asset_id,
        })
        .eq("id", id)
        .eq("org_id", member.orgId)
    : await admin.from("quick_replies").insert(row);
  if (error)
    return {
      ok: false,
      error: error.code === "23505" ? "That shortcut is taken." : "Could not save the quick reply.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "quick_reply.saved",
    entity: "quick_reply",
    entityId: id,
    diff: { shortcut: parsed.data.shortcut, with_file: !!row.media_asset_id },
  });
  revalidate();
  return { ok: true, message: "Quick reply saved." };
}

export async function deleteQuickReply(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("quick_replies")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the quick reply." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "quick_reply.deleted",
    entity: "quick_reply",
    entityId: id,
  });
  revalidate();
  return { ok: true, message: "Quick reply deleted." };
}

// --- Labels (tags with scope = conversation) ---------------------------------

const labelSchema = z.object({ name: nameSchema, color: z.enum(LABEL_COLORS) });

export async function saveLabel(
  id: string | null,
  input: { name: string; color: string },
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { error } = id
    ? await admin
        .from("tags")
        .update({ name: parsed.data.name, color: parsed.data.color })
        .eq("id", id)
        .eq("org_id", member.orgId)
    : await admin.from("tags").insert({
        org_id: member.orgId,
        scope: "conversation",
        name: parsed.data.name,
        color: parsed.data.color,
      });
  if (error)
    return {
      ok: false,
      error: error.code === "23505" ? "That label already exists." : "Could not save the label.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "label.saved",
    entity: "label",
    entityId: id,
    diff: { name: parsed.data.name },
  });
  revalidate();
  return { ok: true, message: "Label saved." };
}

export async function deleteLabel(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("tags")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("scope", "conversation");
  if (error) return { ok: false, error: "Could not delete the label." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "label.deleted",
    entity: "label",
    entityId: id,
  });
  revalidate();
  return { ok: true, message: "Label deleted." };
}
