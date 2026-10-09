"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { readReportSettings, reportSettingsSchema, writeReportSettings } from "@/lib/reports/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/** The SLA threshold behind "SLA breaches" on the team-lead dashboard (orgs.settings->'reports'). */
export async function saveSlaMinutes(minutes: number): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = reportSettingsSchema.safeParse({ sla_minutes: minutes });
  if (!parsed.success) return { ok: false, error: "Enter a whole number of minutes between 1 and 1440." };
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readReportSettings(org?.settings).sla_minutes;
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeReportSettings(org?.settings, parsed.data) as never })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the SLA." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "reports.sla_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { sla_minutes: [before, parsed.data.sla_minutes] },
  });
  revalidatePath("/dashboard/team");
  return { ok: true, message: "SLA updated." };
}
