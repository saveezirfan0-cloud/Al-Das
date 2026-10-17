"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { lifecycleSettingsSchema, writeLifecycleSettings } from "@/lib/contacts/lifecycle-settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type LifecycleActionResult = { ok: true; message: string } | { ok: false; error: string };

/** Saves the lifecycle thresholds (orgs.settings.lifecycle). Audited with field names only, never values. */
export async function saveLifecycleSettingsAction(input: {
  newPatientDays: number;
  activeMonths: number;
}): Promise<LifecycleActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = lifecycleSettingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "New patient days: 1 to 365. Active months: 1 to 60." };
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeLifecycleSettings(org?.settings, parsed.data) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the setting." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "lifecycle.settings_changed",
    entity: "org",
    entityId: member.orgId,
    diff: { fields: ["newPatientDays", "activeMonths"] } as Json,
  });
  revalidatePath("/settings/lifecycle");
  return { ok: true, message: "Saved." };
}
