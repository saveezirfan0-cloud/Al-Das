"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { cleanMenuHidden, readOrgMenuHidden, writeOrgMenuHidden } from "@/lib/nav/menu-visibility";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const hiddenSchema = z.array(z.string().max(200)).max(64);

/** Settings, Menu: the menu entries hidden for everyone in the workspace (orgs.settings.menu.hidden). */
export async function saveWorkspaceMenu(hidden: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = hiddenSchema.safeParse(hidden);
  if (!parsed.success) return { ok: false, error: "That menu choice is not valid." };
  const next = cleanMenuHidden(parsed.data);
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const previous = readOrgMenuHidden(org?.settings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeOrgMenuHidden(org?.settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the menu." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "org.menu_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { hidden: { from: previous, to: next } },
  });
  // the menu is drawn by the app layout on every page
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: next.length ? `Menu saved. ${next.length} hidden for everyone.` : "Menu saved.",
  };
}
