"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  FLOW_TRIGGERABLE_TAGS,
  readCopilotSettings,
  TAG_FLOWS_CONFIRM_PHRASE,
  writeCopilotSettings,
} from "@/lib/ai/copilot/settings";
import { readAiSettings } from "@/lib/ai/settings";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/ai-copilots";
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

async function load(orgId: string) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  return {
    admin,
    settings: org?.settings,
    ai: readAiSettings(org?.settings),
    copilot: readCopilotSettings(org?.settings),
  };
}

/**
 * Sends every inbound patient message to the AI provider to be labelled. A bigger step than staff pressing an AI button, so it has
 * its own switch (settings.manage), needs the main AI switch ON, and is audited. OFF by default (OQ-57).
 */
export async function saveIntentDetection(enabled: boolean): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const { admin, settings, ai, copilot } = await load(member.orgId);
  if (enabled && !ai.enabled)
    return fail(
      "Turn on AI assist first (Settings, AI & knowledge base). Labelling messages needs it.",
    );
  const next = { ...copilot, intent_detection: enabled };
  // Without detection no AI tag can exist, so the approval to start flows from tags is withdrawn with it.
  if (!enabled) next.tag_flows = { enabled: false, tags: [], signed_by: null, signed_at: null };
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeCopilotSettings(settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the setting.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: enabled ? "ai.intent_detection_enabled" : "ai.intent_detection_disabled",
    entity: "org",
    entityId: member.orgId,
    diff: { tag_flows_withdrawn: !enabled && copilot.tag_flows.enabled },
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message: enabled
      ? "Messages will be labelled by AI. Emergency wording is checked either way."
      : "AI labelling is off. Emergency wording is still checked.",
  };
}

const enableSchema = z.object({
  tags: z
    .array(z.enum(FLOW_TRIGGERABLE_TAGS))
    .min(1, "Choose at least one tag.")
    .max(FLOW_TRIGGERABLE_TAGS.length),
  phrase: z.string(),
});

/**
 * Lets chosen AI tags start flows. This is the clinical sign-off OQ-61 asks for: it needs `clinical.settings.manage` (the
 * clinical lead), a typed confirmation, records who and when, and is audited. Never offered for the emergency tag.
 */
export async function enableTagFlows(input: z.input<typeof enableSchema>): Promise<ActionResult> {
  const member = await requirePerm("clinical.settings.manage");
  const parsed = enableSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  if (parsed.data.phrase.trim() !== TAG_FLOWS_CONFIRM_PHRASE)
    return fail(`Type ${TAG_FLOWS_CONFIRM_PHRASE} exactly to give this approval.`);
  const { admin, settings, ai, copilot } = await load(member.orgId);
  if (!ai.enabled || !copilot.intent_detection)
    return fail("AI assist and AI labelling of messages must both be on first.");
  const signedAt = new Date().toISOString();
  const next = {
    ...copilot,
    tag_flows: {
      enabled: true,
      tags: parsed.data.tags,
      signed_by: member.userId,
      signed_at: signedAt,
    },
  };
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeCopilotSettings(settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the approval.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "ai.tag_flows_enabled",
    entity: "org",
    entityId: member.orgId,
    diff: { tags: parsed.data.tags, signed_at: signedAt },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Approved. Flows set to start on these AI tags can now run." };
}

/** Withdrawing the approval is always allowed to the clinical lead or an administrator. */
export async function disableTagFlows(): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "clinical.settings.manage") && !can(member, "settings.manage"))
    return fail("You don't have permission for that.");
  const { admin, settings, copilot } = await load(member.orgId);
  const next = {
    ...copilot,
    tag_flows: { enabled: false, tags: [], signed_by: null, signed_at: null },
  };
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeCopilotSettings(settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not withdraw the approval.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "ai.tag_flows_disabled",
    entity: "org",
    entityId: member.orgId,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Withdrawn. AI tags no longer start flows." };
}
