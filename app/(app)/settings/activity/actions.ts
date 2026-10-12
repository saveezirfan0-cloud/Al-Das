"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Marks a security alert as reviewed. */
export async function acknowledgeAlert(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("security_alerts")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: member.userId })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .is("acknowledged_at", null)
    .select("id, kind");
  if (error || !data?.length) return { ok: false, error: "Alert not found or already reviewed." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "security_alert.acknowledged",
    entity: "security_alert",
    entityId: id,
    diff: { kind: data[0].kind },
  });
  revalidatePath("/settings/activity");
  return { ok: true };
}
