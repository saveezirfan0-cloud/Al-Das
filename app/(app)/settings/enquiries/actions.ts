"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { ruleActionSchema, ruleConditionsSchema } from "@/lib/enquiries/assignment";
import { STAGE_COLORS } from "@/lib/enquiries/constants";
import * as pipelines from "@/lib/enquiries/pipelines";
import { EnquiryError, type Ctx } from "@/lib/enquiries/service";
import { enquirySettingsSchema, writeEnquirySettings } from "@/lib/enquiries/settings";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function refresh() {
  revalidatePath("/settings/enquiries");
  revalidatePath("/enquiries");
}

async function guarded<T>(
  fn: (ctx: Ctx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const member = await requirePerm("settings.manage");
  try {
    return {
      ok: true,
      value: await fn({ admin: createAdminClient(), orgId: member.orgId, userId: member.userId }),
    };
  } catch (e) {
    if (e instanceof EnquiryError) return fail(e.message);
    console.error("[settings/enquiries] action failed", e instanceof Error ? e.name : "unknown");
    return fail("Something went wrong.");
  }
}

/** Every id must exist in `table` for this org (references in rules / notifications / lookups). */
async function ownedBy(
  admin: AdminClient,
  table: "pipelines" | "channels" | "locations" | "departments" | "teams",
  orgId: string,
  ids: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const { count } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("id", unique);
  return count === unique.length;
}

async function membersOf(
  admin: AdminClient,
  orgId: string,
  userIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return true;
  const { count } = await admin
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("user_id", unique);
  return count === unique.length;
}

// ---------------------------------------------------------------------------
// General: SLA, notification rules, sources, task reminders
// ---------------------------------------------------------------------------

export async function saveEnquirySettings(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = enquirySettingsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid settings");
  const admin = createAdminClient();
  const rules = parsed.data.notification_rules;
  const teamIds = rules.map((r) => r.team_id).filter((t): t is string => !!t);
  if (
    !(await ownedBy(admin, "teams", member.orgId, teamIds)) ||
    !(await membersOf(
      admin,
      member.orgId,
      rules.flatMap((r) => r.user_ids),
    ))
  )
    return fail("A notification rule refers to a team or user that does not exist.");
  const sources = [...new Set(parsed.data.sources.map((s) => s.trim()).filter(Boolean))];
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const next = writeEnquirySettings(org?.settings, { ...parsed.data, sources });
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the settings.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "enquiry.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: {
      sla_default_minutes: parsed.data.sla_default_minutes,
      rules: rules.length,
      sources: sources.length,
    },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}

// ---------------------------------------------------------------------------
// Pipelines + stages
// ---------------------------------------------------------------------------

const name = z.string().trim().min(1, "Name is required").max(80);
const sla = z.number().int().min(1).max(10080).nullable();

export async function createPipelineAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = z.object({ name, slaMinutes: sla.optional() }).safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const res = await guarded((ctx) => pipelines.createPipeline(ctx, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true, message: "Pipeline created.", data: res.value };
}

export async function updatePipelineAction(id: string, input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      name: name.optional(),
      slaMinutes: sla.optional(),
      archived: z.boolean().optional(),
      makeDefault: z.boolean().optional(),
    })
    .safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid id" : (parsed.error.issues[0]?.message ?? "Invalid input"),
    );
  const res = await guarded((ctx) => pipelines.updatePipeline(ctx, id, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true, message: "Saved." };
}

export async function reorderPipelinesAction(ids: string[]): Promise<ActionResult> {
  const parsed = z.array(uuid).max(100).safeParse(ids);
  if (!parsed.success) return fail("Invalid order");
  const res = await guarded((ctx) => pipelines.reorderPipelines(ctx, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true };
}

export async function deletePipelineAction(id: string): Promise<ActionResult> {
  if (!uuid.safeParse(id).success) return fail("Invalid id");
  const res = await guarded((ctx) => pipelines.deletePipeline(ctx, id));
  if (!res.ok) return res;
  refresh();
  return { ok: true, message: "Pipeline deleted." };
}

export async function addStageAction(pipelineId: string, input: unknown): Promise<ActionResult> {
  const parsed = z.object({ name, color: z.enum(STAGE_COLORS).optional() }).safeParse(input);
  if (!uuid.safeParse(pipelineId).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid id" : (parsed.error.issues[0]?.message ?? "Invalid input"),
    );
  const res = await guarded((ctx) => pipelines.addStage(ctx, pipelineId, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true };
}

export async function updateStageAction(id: string, input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({ name: name.optional(), color: z.enum(STAGE_COLORS).optional() })
    .safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid id" : (parsed.error.issues[0]?.message ?? "Invalid input"),
    );
  const res = await guarded((ctx) => pipelines.updateStage(ctx, id, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true };
}

export async function reorderStagesAction(
  pipelineId: string,
  ids: string[],
): Promise<ActionResult> {
  const parsed = z.array(uuid).max(100).safeParse(ids);
  if (!uuid.safeParse(pipelineId).success || !parsed.success) return fail("Invalid order");
  const res = await guarded((ctx) => pipelines.reorderStages(ctx, pipelineId, parsed.data));
  if (!res.ok) return res;
  refresh();
  return { ok: true };
}

export async function deleteStageAction(
  id: string,
  moveToStageId?: string | null,
): Promise<ActionResult<{ moved: number }>> {
  if (!uuid.safeParse(id).success || (moveToStageId && !uuid.safeParse(moveToStageId).success))
    return fail("Invalid id");
  const res = await guarded((ctx) => pipelines.deleteStage(ctx, id, moveToStageId));
  if (!res.ok) return res;
  refresh();
  return {
    ok: true,
    message: res.value.moved
      ? `Stage deleted; ${res.value.moved} enquiries moved.`
      : "Stage deleted.",
    data: res.value,
  };
}

// ---------------------------------------------------------------------------
// Assignment rules
// ---------------------------------------------------------------------------

const ruleSchema = z.object({
  name,
  enabled: z.boolean().default(true),
  conditions: ruleConditionsSchema,
  action: ruleActionSchema,
});

export async function saveAssignmentRule(id: string | null, input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid rule");
  const { conditions, action } = parsed.data;
  const admin = createAdminClient();
  const ok =
    (await ownedBy(admin, "pipelines", member.orgId, conditions.pipeline_ids ?? [])) &&
    (await ownedBy(admin, "channels", member.orgId, conditions.channel_ids ?? [])) &&
    (await ownedBy(admin, "locations", member.orgId, conditions.location_ids ?? [])) &&
    (await ownedBy(admin, "departments", member.orgId, conditions.department_ids ?? [])) &&
    (action.type === "user"
      ? await membersOf(admin, member.orgId, [action.user_id])
      : await ownedBy(admin, "teams", member.orgId, [action.team_id]));
  if (!ok) return fail("The rule refers to something that does not exist in this workspace.");
  const row = {
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    conditions: conditions as NonNullable<Json>,
    action: action as NonNullable<Json>,
  };
  if (id) {
    if (!uuid.safeParse(id).success) return fail("Invalid id");
    const { data, error } = await admin
      .from("enquiry_assignment_rules")
      .update(row)
      .eq("org_id", member.orgId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error || !data) return fail("Could not save the rule.");
  } else {
    const { data: existing } = await admin
      .from("enquiry_assignment_rules")
      .select("sort")
      .eq("org_id", member.orgId);
    const sort = (existing ?? []).reduce((m, r) => Math.max(m, r.sort + 1), 0);
    const { error } = await admin
      .from("enquiry_assignment_rules")
      .insert({ org_id: member.orgId, sort, ...row });
    if (error) return fail("Could not create the rule.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "assignment_rule.updated" : "assignment_rule.created",
    entity: "assignment_rule",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Rule saved." };
}

export async function deleteAssignmentRule(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid id");
  const admin = createAdminClient();
  const { data } = await admin
    .from("enquiry_assignment_rules")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (!data) return fail("Rule not found.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "assignment_rule.deleted",
    entity: "assignment_rule",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Rule deleted." };
}

export async function reorderAssignmentRules(ids: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = z.array(uuid).max(200).safeParse(ids);
  if (!parsed.success) return fail("Invalid order");
  const admin = createAdminClient();
  await Promise.all(
    parsed.data.map((id, i) =>
      admin
        .from("enquiry_assignment_rules")
        .update({ sort: i })
        .eq("org_id", member.orgId)
        .eq("id", id),
    ),
  );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "assignment_rule.reordered",
    entity: "assignment_rule",
    diff: { count: parsed.data.length },
  });
  refresh();
  return { ok: true };
}
