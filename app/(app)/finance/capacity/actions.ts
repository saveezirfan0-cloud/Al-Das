"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Capacity (M3): the room opening hours setting (finance.targets.manage). The write uses the service role after the check
 * and is audited. Doctors are linked to the Unite report on the Doctors page (one link, docs/34 Phase C).
 */

const refresh = () => revalidatePath("/finance/capacity");

const openHoursSchema = z.object({
  room_open_hours_per_day: z.coerce
    .number({ message: "Hours must be a number." })
    .gt(0, "Hours must be more than 0.")
    .max(24, "Hours must be at most 24.")
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most two decimals."),
});

export async function saveRoomOpenHours(values: Record<string, string>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.targets.manage")) return fail(DENIED);
  const parsed = openHoursSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...parsed.data }, { onConflict: "org_id" });
  if (error) return fail("Could not save the opening hours.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.room_open_hours_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  refresh();
  return { ok: true, message: "Opening hours saved." };
}
