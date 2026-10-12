"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  frontDeskSettingsSchema,
  readFrontDeskSettings,
  writeFrontDeskSettings,
} from "@/lib/front-desk/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function saveFrontDeskSettings(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = frontDeskSettingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the settings." };
  const next = parsed.data;
  const admin = createAdminClient(member.userId);

  // Every template and number named must belong to this workspace, and templates must be approved by Meta.
  const templateIds = [
    next.offer_template_id,
    next.running_late_template_id,
    next.location_template_id,
  ].filter((t): t is string => !!t);
  if (templateIds.length) {
    const { data } = await admin
      .from("wa_templates")
      .select("id, status, name")
      .eq("org_id", member.orgId)
      .in("id", templateIds);
    for (const id of templateIds) {
      const t = data?.find((x) => x.id === id);
      if (!t) return { ok: false, error: "A chosen template does not exist in this workspace." };
      if (t.status !== "APPROVED")
        return { ok: false, error: `Template "${t.name}" is ${t.status}, not approved yet.` };
    }
  }
  if (next.desk_channel_id) {
    const { data } = await admin
      .from("channels")
      .select("id")
      .eq("id", next.desk_channel_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return { ok: false, error: "That WhatsApp number does not exist here." };
  }

  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readFrontDeskSettings(org?.settings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeFrontDeskSettings(org?.settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the settings." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "frontdesk.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: {
      offers_enabled: { from: before.offers_enabled, to: next.offers_enabled },
      offer_ttl_minutes: next.offer_ttl_minutes,
      offer_batch_size: next.offer_batch_size,
    } as Json,
  });
  revalidatePath("/settings/front-desk");
  revalidatePath("/front-desk");
  return { ok: true, message: "Front desk settings saved." };
}
