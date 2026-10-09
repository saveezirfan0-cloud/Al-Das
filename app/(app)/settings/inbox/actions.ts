"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { inboxSettingsSchema, writeInboxSettings, type InboxSettings } from "@/lib/inbox/settings";
import { createAdminClient } from "@/lib/supabase/admin";
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
});

export async function saveQuickReply(
  id: string | null,
  input: { shortcut: string; text: string },
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = quickReplySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const row = {
    org_id: member.orgId,
    shortcut: parsed.data.shortcut,
    text: parsed.data.text,
    created_by: member.userId,
  };
  const { error } = id
    ? await admin
        .from("quick_replies")
        .update({ shortcut: row.shortcut, text: row.text })
        .eq("id", id)
        .eq("org_id", member.orgId)
    : await admin.from("quick_replies").insert(row);
  if (error)
    return {
      ok: false,
      error: error.code === "23505" ? "That shortcut is taken." : "Could not save the quick reply.",
    };
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
  revalidate();
  return { ok: true, message: "Quick reply deleted." };
}

// --- Labels (tags with scope = conversation) ---------------------------------

export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

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
    : await admin
        .from("tags")
        .insert({
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
  revalidate();
  return { ok: true, message: "Label deleted." };
}
