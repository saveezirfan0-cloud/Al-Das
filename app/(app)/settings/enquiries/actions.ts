"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { CARD_FIELDS } from "@/lib/enquiries/columns";
import { STAGE_COLORS } from "@/lib/enquiries/defaults";
import { nextSort, sameIdSet, sortValues } from "@/lib/enquiries/ordering";
import { enquirySettingsSchema, writeEnquirySettings } from "@/lib/enquiries/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T extends object = object> =
  ({ ok: true; message?: string } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const name = z.string().trim().min(1, "Give it a name.").max(80);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function refresh() {
  revalidatePath("/settings/enquiries");
  revalidatePath("/enquiries");
}

async function audit(
  member: { orgId: string; userId: string },
  action: string,
  entityId: string | null,
  diff: Record<string, unknown>,
) {
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action,
    entity: "enquiry_config",
    entityId,
    diff: diff as Json,
  });
}

// ---------------------------------------------------------------------------
// Workspace settings: SLA, notification rules, assignment rule
// ---------------------------------------------------------------------------

export async function saveEnquirySettings(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = enquirySettingsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid settings.");
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const next = writeEnquirySettings(org?.settings, parsed.data);
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not save the settings.");
  await audit(member, "enquiry.settings_updated", member.orgId, parsed.data);
  refresh();
  return { ok: true, message: "Settings saved." };
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

const cardFieldKeys = CARD_FIELDS.map((f) => f.key) as [string, ...string[]];

const pipelineSchema = z.object({
  name,
  default_team_id: uuid.nullable(),
  card_fields: z.array(z.enum(cardFieldKeys)).max(CARD_FIELDS.length),
});

async function teamOk(orgId: string, teamId: string | null): Promise<boolean> {
  if (!teamId) return true;
  const { data } = await createAdminClient()
    .from("teams")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", teamId)
    .maybeSingle();
  return !!data;
}

export async function createPipeline(
  input: z.input<typeof pipelineSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("settings.manage");
  const parsed = pipelineSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  if (!(await teamOk(member.orgId, parsed.data.default_team_id)))
    return fail("That team does not exist.");
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("pipelines")
    .select("sort")
    .eq("org_id", member.orgId);
  const { data, error } = await admin
    .from("pipelines")
    .insert({
      org_id: member.orgId,
      ...parsed.data,
      sort: nextSort((existing ?? []).map((p) => p.sort)),
    })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      error?.code === "23505"
        ? "A pipeline with that name already exists."
        : "Could not create the pipeline.",
    );
  // A pipeline needs at least one stage to be usable.
  await admin.from("stages").insert([
    { org_id: member.orgId, pipeline_id: data.id, name: "New", color: "slate", sort: 10 },
    { org_id: member.orgId, pipeline_id: data.id, name: "In progress", color: "blue", sort: 20 },
  ]);
  await audit(member, "enquiry.pipeline_created", data.id, { name: parsed.data.name });
  refresh();
  return { ok: true, id: data.id };
}

export async function updatePipeline(
  id: string,
  input: z.input<typeof pipelineSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = pipelineSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid input." : (parsed.error.issues[0]?.message ?? "Invalid input."),
    );
  if (!(await teamOk(member.orgId, parsed.data.default_team_id)))
    return fail("That team does not exist.");
  const { data, error } = await createAdminClient()
    .from("pipelines")
    .update(parsed.data)
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error)
    return fail(
      error.code === "23505"
        ? "A pipeline with that name already exists."
        : "Could not save the pipeline.",
    );
  if (!data) return fail("Pipeline not found.");
  await audit(member, "enquiry.pipeline_updated", id, {
    name: parsed.data.name,
    team: parsed.data.default_team_id,
    card_fields: parsed.data.card_fields,
  });
  refresh();
  return { ok: true };
}

/** Archiving hides a pipeline; it is refused while open enquiries still sit in it. */
export async function archivePipeline(id: string, archived: boolean): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid input.");
  const admin = createAdminClient();
  if (archived) {
    const { count } = await admin
      .from("enquiries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("pipeline_id", id)
      .eq("status", "open");
    if ((count ?? 0) > 0) return fail(`Move or close its ${count} open enquiries first.`);
    const { count: active } = await admin
      .from("pipelines")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .is("archived_at", null);
    if ((active ?? 0) <= 1) return fail("Keep at least one active pipeline.");
  }
  const { data, error } = await admin
    .from("pipelines")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("Could not update the pipeline.");
  await audit(member, archived ? "enquiry.pipeline_archived" : "enquiry.pipeline_restored", id, {});
  refresh();
  return { ok: true };
}

export async function reorderPipelines(ids: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const list = z.array(uuid).min(1).max(100).safeParse(ids);
  if (!list.success) return fail("Invalid input.");
  const admin = createAdminClient();
  const { data: current } = await admin.from("pipelines").select("id").eq("org_id", member.orgId);
  if (
    !sameIdSet(
      list.data,
      (current ?? []).map((p) => p.id),
    )
  )
    return fail("The list is out of date. Reload and try again.");
  for (const { id, sort } of sortValues(list.data))
    await admin.from("pipelines").update({ sort }).eq("org_id", member.orgId).eq("id", id);
  await audit(member, "enquiry.pipelines_reordered", null, { count: list.data.length });
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const stageSchema = z.object({ name, color: z.enum(STAGE_COLORS) });

export async function createStage(
  pipelineId: string,
  input: z.input<typeof stageSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("settings.manage");
  const parsed = stageSchema.safeParse(input);
  if (!uuid.safeParse(pipelineId).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid input." : (parsed.error.issues[0]?.message ?? "Invalid input."),
    );
  const admin = createAdminClient();
  const { data: pipeline } = await admin
    .from("pipelines")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (!pipeline) return fail("Pipeline not found.");
  const { data: existing } = await admin
    .from("stages")
    .select("sort")
    .eq("pipeline_id", pipelineId);
  const { data, error } = await admin
    .from("stages")
    .insert({
      org_id: member.orgId,
      pipeline_id: pipelineId,
      ...parsed.data,
      sort: nextSort((existing ?? []).map((s) => s.sort)),
    })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      error?.code === "23505"
        ? "This pipeline already has a stage with that name."
        : "Could not add the stage.",
    );
  await audit(member, "enquiry.stage_created", data.id, {
    pipeline_id: pipelineId,
    name: parsed.data.name,
  });
  refresh();
  return { ok: true, id: data.id };
}

export async function updateStage(
  id: string,
  input: z.input<typeof stageSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = stageSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid input." : (parsed.error.issues[0]?.message ?? "Invalid input."),
    );
  const { data, error } = await createAdminClient()
    .from("stages")
    .update(parsed.data)
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error)
    return fail(
      error.code === "23505"
        ? "This pipeline already has a stage with that name."
        : "Could not save the stage.",
    );
  if (!data) return fail("Stage not found.");
  await audit(member, "enquiry.stage_updated", id, parsed.data);
  refresh();
  return { ok: true };
}

/** A stage can only be removed when it is empty and not the pipeline's last one. */
export async function deleteStage(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid input.");
  const admin = createAdminClient();
  const { data: stage } = await admin
    .from("stages")
    .select("id, pipeline_id, name")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!stage) return fail("Stage not found.");
  const [{ count: used }, { count: siblings }] = await Promise.all([
    admin
      .from("enquiries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("stage_id", id),
    admin
      .from("stages")
      .select("id", { count: "exact", head: true })
      .eq("pipeline_id", stage.pipeline_id),
  ]);
  if ((used ?? 0) > 0) return fail(`${used} enquiries are in this stage. Move them first.`);
  if ((siblings ?? 0) <= 1) return fail("A pipeline needs at least one stage.");
  const { error } = await admin.from("stages").delete().eq("org_id", member.orgId).eq("id", id);
  if (error) return fail("Could not delete the stage.");
  await audit(member, "enquiry.stage_deleted", id, {
    pipeline_id: stage.pipeline_id,
    name: stage.name,
  });
  refresh();
  return { ok: true };
}

export async function reorderStages(pipelineId: string, ids: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const list = z.array(uuid).min(1).max(100).safeParse(ids);
  if (!uuid.safeParse(pipelineId).success || !list.success) return fail("Invalid input.");
  const admin = createAdminClient();
  const { data: current } = await admin
    .from("stages")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("pipeline_id", pipelineId);
  if (
    !sameIdSet(
      list.data,
      (current ?? []).map((s) => s.id),
    )
  )
    return fail("The list is out of date. Reload and try again.");
  for (const { id, sort } of sortValues(list.data))
    await admin.from("stages").update({ sort }).eq("org_id", member.orgId).eq("id", id);
  await audit(member, "enquiry.stages_reordered", pipelineId, { count: list.data.length });
  refresh();
  return { ok: true };
}
