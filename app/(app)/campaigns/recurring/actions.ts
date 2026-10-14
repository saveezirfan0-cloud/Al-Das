"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  campaignBudgetSchema,
  readCampaignBudget,
  writeCampaignBudget,
} from "@/lib/campaigns/budget";
import { checkRecurrenceSchedule, nextCronRun } from "@/lib/campaigns/recurrence";
import { scheduleRecurrenceRun } from "@/lib/campaigns/recurring";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();

function revalidate() {
  revalidatePath("/campaigns/recurring");
  revalidatePath("/campaigns");
}

async function ownedRecurrence(orgId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("campaign_recurrences")
    .select("id, org_id, status, cron, timezone, next_run_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data ? { admin, rec: data } : null;
}

/** Pause: the scheduled run finds the series paused and does nothing. Running campaigns are not touched. */
export async function pauseRecurrence(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedRecurrence(member.orgId, id);
  if (!found) return { ok: false, error: "Recurring campaign not found." };
  if (found.rec.status === "paused") return { ok: true, message: "Already paused." };
  await found.admin
    .from("campaign_recurrences")
    .update({ status: "paused" })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign_recurrence.paused",
    entity: "campaign_recurrence",
    entityId: id,
  });
  revalidate();
  return { ok: true, message: "Paused. No further runs until you press play." };
}

/** Play: the next run is worked out from now (missed runs are not caught up) and scheduled. */
export async function resumeRecurrence(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedRecurrence(member.orgId, id);
  if (!found) return { ok: false, error: "Recurring campaign not found." };
  const now = new Date();
  const problem = checkRecurrenceSchedule(found.rec.cron, found.rec.timezone, now);
  if (problem) return { ok: false, error: problem };
  const next = nextCronRun(found.rec.cron, now, found.rec.timezone);
  if (!next) return { ok: false, error: "That schedule never runs in the next year." };
  const { data: updated } = await found.admin
    .from("campaign_recurrences")
    .update({ status: "active", next_run_at: next.toISOString() })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id, org_id")
    .maybeSingle();
  if (!updated) return { ok: false, error: "Could not resume it." };
  await scheduleRecurrenceRun(updated, next);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign_recurrence.resumed",
    entity: "campaign_recurrence",
    entityId: id,
    diff: { next_run_at: next.toISOString() },
  });
  revalidate();
  return { ok: true, message: "Running again." };
}

/** Delete the series. Campaigns it already created stay (with their history); nothing new is created. */
export async function deleteRecurrence(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedRecurrence(member.orgId, id);
  if (!found) return { ok: false, error: "Recurring campaign not found." };
  const { error } = await found.admin
    .from("campaign_recurrences")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete it." };
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign_recurrence.deleted",
    entity: "campaign_recurrence",
    entityId: id,
  });
  revalidate();
  return { ok: true, message: "Recurring campaign deleted." };
}

/** The monthly campaign message budget. Administrators only (settings.manage); audited with the old and new value. */
export async function saveCampaignBudget(
  input: z.input<typeof campaignBudgetSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = campaignBudgetSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Enter a whole number, or leave it empty for no limit." };
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readCampaignBudget(org?.settings);
  const next = writeCampaignBudget(org?.settings, parsed.data);
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the budget." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign_budget.updated",
    entity: "org",
    entityId: member.orgId,
    diff: { from: before.monthly_limit, to: parsed.data.monthly_limit },
  });
  revalidate();
  return {
    ok: true,
    message:
      parsed.data.monthly_limit === null
        ? "Budget removed: campaigns are counted but not limited."
        : `Monthly budget set to ${parsed.data.monthly_limit.toLocaleString("en-US")} messages.`,
  };
}
