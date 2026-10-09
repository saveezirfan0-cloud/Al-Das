import "server-only";

import { recordAudit } from "@/lib/audit";
import { STAGE_COLORS } from "@/lib/enquiries/constants";
import { EnquiryError, type Ctx } from "@/lib/enquiries/service";
import type { Tables, TablesUpdate } from "@/lib/supabase/types";

/** Stages a new pipeline starts with. */
export const STARTER_STAGES = [
  { name: "New", color: "blue" },
  { name: "In progress", color: "amber" },
  { name: "Booked", color: "green" },
] as const;

function dbError(error: { code?: string }, fallback: string): EnquiryError {
  if (error.code === "23505") return new EnquiryError("That name is already in use.");
  console.error("[pipelines] db error", { code: error.code });
  return new EnquiryError(fallback);
}

async function audit(
  ctx: Ctx,
  action: string,
  entity: string,
  entityId: string | null,
  diff: Record<string, unknown> = {},
) {
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action,
    entity,
    entityId,
    diff: diff as never,
  });
}

async function loadPipeline(ctx: Ctx, id: string): Promise<Tables<"pipelines">> {
  const { data } = await ctx.admin
    .from("pipelines")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new EnquiryError("Pipeline not found.");
  return data;
}

export async function createPipeline(
  ctx: Ctx,
  input: {
    name: string;
    slaMinutes?: number | null;
    stages?: ReadonlyArray<{ name: string; color?: string }>;
  },
): Promise<{ id: string }> {
  const { data: existing } = await ctx.admin
    .from("pipelines")
    .select("id, sort")
    .eq("org_id", ctx.orgId);
  const sort = (existing ?? []).reduce((m, p) => Math.max(m, p.sort + 1), 0);
  const { data, error } = await ctx.admin
    .from("pipelines")
    .insert({
      org_id: ctx.orgId,
      name: input.name,
      sla_minutes: input.slaMinutes ?? null,
      sort,
      is_default: (existing ?? []).length === 0,
    })
    .select("id")
    .single();
  if (error || !data) throw dbError(error ?? {}, "Could not create the pipeline.");
  const stages = input.stages?.length ? input.stages : STARTER_STAGES;
  const { error: stageError } = await ctx.admin.from("stages").insert(
    stages.map((s, i) => ({
      org_id: ctx.orgId,
      pipeline_id: data.id,
      name: s.name,
      color: s.color && (STAGE_COLORS as readonly string[]).includes(s.color) ? s.color : "gray",
      sort: i,
    })),
  );
  if (stageError) {
    await ctx.admin.from("pipelines").delete().eq("id", data.id);
    throw dbError(stageError, "Could not create the pipeline's stages.");
  }
  await audit(ctx, "pipeline.created", "pipeline", data.id, { name: input.name });
  return data;
}

export async function updatePipeline(
  ctx: Ctx,
  id: string,
  patch: { name?: string; slaMinutes?: number | null; archived?: boolean; makeDefault?: boolean },
): Promise<void> {
  const p = await loadPipeline(ctx, id);
  const update: TablesUpdate<"pipelines"> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.slaMinutes !== undefined) update.sla_minutes = patch.slaMinutes;
  if (patch.archived !== undefined) {
    if (patch.archived && p.is_default && !patch.makeDefault)
      throw new EnquiryError("Make another pipeline the default before archiving this one.");
    update.archived_at = patch.archived ? new Date().toISOString() : null;
  }
  if (patch.makeDefault) {
    if (p.archived_at && patch.archived !== false)
      throw new EnquiryError("An archived pipeline cannot be the default.");
    // The unique index allows one default per org: clear the old one first.
    const { error: clearError } = await ctx.admin
      .from("pipelines")
      .update({ is_default: false })
      .eq("org_id", ctx.orgId)
      .eq("is_default", true);
    if (clearError) throw dbError(clearError, "Could not change the default pipeline.");
    update.is_default = true;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await ctx.admin
    .from("pipelines")
    .update(update)
    .eq("org_id", ctx.orgId)
    .eq("id", id);
  if (error) throw dbError(error, "Could not save the pipeline.");
  await audit(ctx, "pipeline.updated", "pipeline", id, { fields: Object.keys(update) });
}

export async function reorderPipelines(ctx: Ctx, orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, i) =>
      ctx.admin.from("pipelines").update({ sort: i }).eq("org_id", ctx.orgId).eq("id", id),
    ),
  );
}

/** Pipelines that ever held enquiries are archived, not deleted (history and reports keep working). */
export async function deletePipeline(ctx: Ctx, id: string): Promise<void> {
  const p = await loadPipeline(ctx, id);
  if (p.is_default)
    throw new EnquiryError(
      "The default pipeline cannot be deleted. Make another one the default first.",
    );
  const { count } = await ctx.admin
    .from("enquiries")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.orgId)
    .eq("pipeline_id", id);
  if (count)
    throw new EnquiryError(
      "This pipeline has enquiries. Archive it instead, or move them to another pipeline first.",
    );
  const { error } = await ctx.admin.from("pipelines").delete().eq("org_id", ctx.orgId).eq("id", id);
  if (error) throw dbError(error, "Could not delete the pipeline.");
  await audit(ctx, "pipeline.deleted", "pipeline", id, { name: p.name });
}

export async function addStage(
  ctx: Ctx,
  pipelineId: string,
  input: { name: string; color?: string },
): Promise<{ id: string }> {
  await loadPipeline(ctx, pipelineId);
  const { data: existing } = await ctx.admin
    .from("stages")
    .select("sort")
    .eq("org_id", ctx.orgId)
    .eq("pipeline_id", pipelineId);
  const sort = (existing ?? []).reduce((m, s) => Math.max(m, s.sort + 1), 0);
  const { data, error } = await ctx.admin
    .from("stages")
    .insert({
      org_id: ctx.orgId,
      pipeline_id: pipelineId,
      name: input.name,
      color:
        input.color && (STAGE_COLORS as readonly string[]).includes(input.color)
          ? input.color
          : "gray",
      sort,
    })
    .select("id")
    .single();
  if (error || !data) throw dbError(error ?? {}, "Could not add the stage.");
  await audit(ctx, "stage.created", "stage", data.id, { pipeline_id: pipelineId });
  return data;
}

export async function updateStage(
  ctx: Ctx,
  id: string,
  patch: { name?: string; color?: string },
): Promise<void> {
  const update: TablesUpdate<"stages"> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.color !== undefined) {
    if (!(STAGE_COLORS as readonly string[]).includes(patch.color))
      throw new EnquiryError("Unknown colour.");
    update.color = patch.color;
  }
  if (Object.keys(update).length === 0) return;
  const { data, error } = await ctx.admin
    .from("stages")
    .update(update)
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error, "Could not save the stage.");
  if (!data) throw new EnquiryError("Stage not found.");
  await audit(ctx, "stage.updated", "stage", id, { fields: Object.keys(update) });
}

export async function reorderStages(
  ctx: Ctx,
  pipelineId: string,
  orderedIds: string[],
): Promise<void> {
  const { data } = await ctx.admin
    .from("stages")
    .select("id")
    .eq("org_id", ctx.orgId)
    .eq("pipeline_id", pipelineId);
  const have = new Set((data ?? []).map((s) => s.id));
  if (orderedIds.length !== have.size || !orderedIds.every((id) => have.has(id)))
    throw new EnquiryError("The stage list is out of date. Reload and try again.");
  await Promise.all(
    orderedIds.map((id, i) =>
      ctx.admin.from("stages").update({ sort: i }).eq("org_id", ctx.orgId).eq("id", id),
    ),
  );
}

/**
 * Deletes a stage. If enquiries sit in it (including soft-deleted ones, which still
 * reference it) they must be moved to `moveToStageId`, another stage of the same pipeline.
 */
export async function deleteStage(
  ctx: Ctx,
  id: string,
  moveToStageId?: string | null,
): Promise<{ moved: number }> {
  const { data: stage } = await ctx.admin
    .from("stages")
    .select("id, pipeline_id, name")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!stage) throw new EnquiryError("Stage not found.");
  const { count } = await ctx.admin
    .from("enquiries")
    .select("id", { count: "exact", head: true })
    .eq("org_id", ctx.orgId)
    .eq("stage_id", id);
  let moved = 0;
  if (count) {
    if (!moveToStageId || moveToStageId === id)
      throw new EnquiryError(
        `${count} enquir${count === 1 ? "y is" : "ies are"} in this stage. Choose a stage to move them to.`,
      );
    const { data: target } = await ctx.admin
      .from("stages")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("id", moveToStageId)
      .eq("pipeline_id", stage.pipeline_id)
      .maybeSingle();
    if (!target) throw new EnquiryError("Choose a stage from the same pipeline.");
    const { error: moveError } = await ctx.admin
      .from("enquiries")
      .update({ stage_id: moveToStageId })
      .eq("org_id", ctx.orgId)
      .eq("stage_id", id);
    if (moveError) throw dbError(moveError, "Could not move the enquiries.");
    moved = count;
  }
  const { error } = await ctx.admin.from("stages").delete().eq("org_id", ctx.orgId).eq("id", id);
  if (error) throw dbError(error, "Could not delete the stage.");
  await audit(ctx, "stage.deleted", "stage", id, { name: stage.name, moved });
  return { moved };
}
