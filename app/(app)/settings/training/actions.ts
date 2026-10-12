"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { CLIPS, readHelpSettings, videoUrlSchema, writeHelpSettings } from "@/lib/help/clips";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const modeSchema = z.object({
  enabled: z.boolean(),
  /** The person must type the word: switching a live workspace to training stops every WhatsApp send. */
  confirm: z.string().trim(),
});

export async function setTrainingMode(input: z.input<typeof modeSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const p = modeSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const word = p.data.enabled ? "TRAINING" : "GO LIVE";
  if (p.data.confirm !== word) return { ok: false, error: `Type ${word} to confirm.` };
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("orgs")
    .update({ is_training: p.data.enabled })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not change training mode." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: p.data.enabled ? "training.enabled" : "training.disabled",
    entity: "org",
    entityId: member.orgId,
  });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: p.data.enabled
      ? "Training mode is on. Nothing will be sent to WhatsApp."
      : "Training mode is off. Messages are sent for real again.",
  };
}

const videosSchema = z.record(z.string(), z.union([videoUrlSchema, z.literal("")]));

export async function saveVideoLinks(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const p = videosSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Use https links." };
  const known = new Set(CLIPS.map((c) => c.id));
  const videos: Record<string, string> = {};
  for (const [id, url] of Object.entries(p.data)) {
    if (known.has(id) && url) videos[id] = url;
  }
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeHelpSettings(org?.settings, { videos }) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the links." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "training.videos_updated",
    entity: "org",
    entityId: member.orgId,
    diff: {
      recorded: Object.keys(videos).length,
      previously: Object.keys(readHelpSettings(org?.settings).videos).length,
    },
  });
  revalidatePath("/help/training");
  revalidatePath("/settings/training");
  return { ok: true, message: "Video links saved." };
}
