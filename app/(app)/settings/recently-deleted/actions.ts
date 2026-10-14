"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { afterEnquiryRestored } from "@/lib/enquiries/service";
import { canSeeEnquiry, enquiryViewer } from "@/lib/enquiries/visibility";
import {
  ENTITY_RULES,
  isSoftDeleteEntity,
  restoreOutcomeMessage,
  restoreWindowSchema,
  writeRestoreWindowDays,
  readRestoreWindowDays,
} from "@/lib/soft-delete/rules";
import { createAdminClient } from "@/lib/supabase/admin";
import { afterTaskRestored } from "@/lib/tasks/service";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/recently-deleted";

/** Where a restored record shows up again. */
const LIST_PATHS = {
  contact: "/contacts",
  enquiry: "/enquiries",
  task: "/tasks",
  website_entry_point: "/portal/website_entry_points",
} as const;

/**
 * Restores one record from the bin. Needs the record's own manage permission (enquiries: manage or delete) and, for an
 * enquiry, the member's enquiry view must include it. Then reminders come back: a task's due reminder, an enquiry's SLA. The database refuses past the window, on a clash and when its parent is in the bin.
 */
export async function restoreDeletedItem(entity: string, id: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!isSoftDeleteEntity(entity) || !z.string().uuid().safeParse(id).success)
    return { ok: false, error: "Invalid request" };
  const rule = ENTITY_RULES[entity];
  // The record's own manage key (enquiries: manage or delete), as canRestore() in lib/soft-delete/rules.ts.
  if (!canAny(member, rule.restorePerms))
    return { ok: false, error: "You do not have permission to restore this." };
  const admin = createAdminClient(member.userId);
  if (
    entity === "enquiry" &&
    !(await canSeeEnquiry(admin, member.orgId, await enquiryViewer(admin, member), id))
  )
    return { ok: false, error: "This item is no longer in Recently deleted." };

  // public.restore_deleted_record checks the window, clashes and parents in one transaction (service role only).
  const { data: outcome, error } = await admin.rpc("restore_deleted_record", {
    p_org: member.orgId,
    p_entity: entity,
    p_id: id,
    p_actor: member.userId,
  });
  if (error) return { ok: false, error: "Could not restore it. Try again." };
  const res = restoreOutcomeMessage(entity, String(outcome ?? "not_found"));
  if (!res.ok) return { ok: false, error: res.message };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: entity === "website_entry_point" ? "portal.record_restored" : `${entity}.restored`,
    entity: rule.auditEntity,
    entityId: id,
  });
  if (entity === "task")
    await afterTaskRestored({ admin, orgId: member.orgId, userId: member.userId }, id);
  if (entity === "enquiry")
    await afterEnquiryRestored({ admin, orgId: member.orgId, userId: member.userId }, id);
  revalidatePath(PATH);
  revalidatePath(LIST_PATHS[entity]);
  return { ok: true, message: res.message };
}

/** How long deleted records can be restored (orgs.settings.soft_delete.restore_window_days, 1 to 90 days). */
export async function saveRestoreWindow(days: number): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const parsed = restoreWindowSchema.safeParse(days);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readRestoreWindowDays(org?.settings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeRestoreWindowDays(org?.settings, parsed.data) as never })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the setting." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "soft_delete.window_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { from: before, to: parsed.data },
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message:
      parsed.data < before
        ? `Saved. Items deleted more than ${parsed.data} days ago will be removed tonight.`
        : "Saved.",
  };
}
