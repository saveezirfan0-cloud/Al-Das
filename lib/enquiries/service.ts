import "server-only";

import { addTimelineEvent, diffFields } from "@/lib/contacts/timeline";
import { firstMatchingRule } from "@/lib/enquiries/assignment";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import { registerEnquiryListeners } from "@/lib/enquiries/notify";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { computeSlaDueAt, resolveSlaMinutes } from "@/lib/enquiries/sla";
import { resolveStatusChange } from "@/lib/enquiries/status";
import { recordAudit } from "@/lib/audit";
import { emit } from "@/lib/events/emit";
import { scheduleJob } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables, TablesUpdate } from "@/lib/supabase/types";

// Importing the service registers the in-process notification listeners, so any
// entry point that can emit an enquiry event (server action, job handler) has them.
registerEnquiryListeners();

export class EnquiryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnquiryError";
  }
}

export type Ctx = { admin: AdminClient; orgId: string; userId: string | null };

type Enquiry = Tables<"enquiries">;

/** Maps Postgres integrity errors from the org / stage triggers to something a user can act on. */
function dbError(error: { code?: string; message: string }, fallback: string): EnquiryError {
  if (error.code === "23514") return new EnquiryError("One of the selected values is not valid for this workspace.");
  if (error.code === "23505") return new EnquiryError("That value is already in use.");
  console.error("[enquiries] db error", { code: error.code });
  return new EnquiryError(fallback);
}

async function loadEnquiry(ctx: Ctx, id: string): Promise<Enquiry> {
  const { data } = await ctx.admin
    .from("enquiries")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new EnquiryError("Enquiry not found.");
  return data;
}

async function stageInfo(ctx: Ctx, stageId: string) {
  const { data } = await ctx.admin
    .from("stages")
    .select("id, name, pipeline_id")
    .eq("org_id", ctx.orgId)
    .eq("id", stageId)
    .maybeSingle();
  return data;
}

async function firstStage(ctx: Ctx, pipelineId: string) {
  const { data } = await ctx.admin
    .from("stages")
    .select("id, name, pipeline_id")
    .eq("org_id", ctx.orgId)
    .eq("pipeline_id", pipelineId)
    .order("sort")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return data;
}

/** First touch: stops the SLA clock. Safe to call repeatedly. */
export async function markTouched(admin: AdminClient, orgId: string, enquiryId: string): Promise<void> {
  await admin
    .from("enquiries")
    .update({ first_touch_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", enquiryId)
    .is("first_touch_at", null);
}

async function timeline(ctx: Ctx, e: Pick<Enquiry, "id" | "contact_id">, type: string, payload: Json) {
  await addTimelineEvent(ctx.admin, {
    orgId: ctx.orgId,
    contactId: e.contact_id,
    enquiryId: e.id,
    type,
    actorType: ctx.userId ? "user" : "system",
    actorId: ctx.userId,
    payload,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type EnquiryCreate = {
  title: string;
  pipelineId: string;
  stageId?: string | null;
  contactId?: string | null;
  channelId?: string | null;
  source?: string | null;
  /** undefined = run the assignment rules; null = deliberately unassigned. */
  assigneeId?: string | null;
  estValue?: number | null;
  locationId?: string | null;
  departmentId?: string | null;
  specialistId?: string | null;
  serviceId?: string | null;
  apptDate?: string | null;
  custom?: Record<string, unknown>;
};

export async function createEnquiry(ctx: Ctx, input: EnquiryCreate): Promise<{ id: string; number: number }> {
  const { data: pipeline } = await ctx.admin
    .from("pipelines")
    .select("id, sla_minutes, archived_at")
    .eq("org_id", ctx.orgId)
    .eq("id", input.pipelineId)
    .maybeSingle();
  if (!pipeline || pipeline.archived_at) throw new EnquiryError("That pipeline is not available.");

  const stage = input.stageId ? await stageInfo(ctx, input.stageId) : await firstStage(ctx, pipeline.id);
  if (!stage || stage.pipeline_id !== pipeline.id) throw new EnquiryError("That stage does not belong to the pipeline.");

  const { data: org } = await ctx.admin.from("orgs").select("settings").eq("id", ctx.orgId).single();
  const settings = readEnquirySettings(org?.settings);

  let assigneeId = input.assigneeId ?? null;
  let assignedBy: "user" | "rule" | null = input.assigneeId ? "user" : null;
  if (input.assigneeId === undefined) {
    const { data: rules } = await ctx.admin
      .from("enquiry_assignment_rules")
      .select("id, name, sort, enabled, conditions, action")
      .eq("org_id", ctx.orgId);
    const match = firstMatchingRule(rules ?? [], {
      pipeline_id: pipeline.id,
      source: input.source,
      channel_id: input.channelId,
      location_id: input.locationId,
      department_id: input.departmentId,
    });
    if (match?.action.type === "user") assigneeId = match.action.user_id;
    if (match?.action.type === "team_round_robin") {
      const { data } = await ctx.admin.rpc("pick_round_robin_assignee", {
        p_org_id: ctx.orgId,
        p_team_id: match.action.team_id,
      });
      assigneeId = data ?? null;
    }
    if (assigneeId) assignedBy = "rule";
  }

  const now = new Date();
  const slaDueAt = computeSlaDueAt(now, resolveSlaMinutes(pipeline.sla_minutes, settings.sla_default_minutes));
  const { data, error } = await ctx.admin
    .from("enquiries")
    .insert({
      org_id: ctx.orgId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      title: input.title,
      contact_id: input.contactId ?? null,
      channel_id: input.channelId ?? null,
      source: input.source ?? null,
      assignee_id: assigneeId,
      est_value: input.estValue ?? null,
      location_id: input.locationId ?? null,
      department_id: input.departmentId ?? null,
      specialist_id: input.specialistId ?? null,
      service_id: input.serviceId ?? null,
      appt_date: input.apptDate ?? null,
      custom: (input.custom ?? {}) as NonNullable<Json>,
      sla_due_at: slaDueAt?.toISOString() ?? null,
      created_by: ctx.userId,
    })
    .select("id, number")
    .single();
  if (error || !data) throw dbError(error ?? { message: "no row" }, "Could not create the enquiry.");

  await timeline(ctx, { id: data.id, contact_id: input.contactId ?? null }, "enquiry.created", {
    number: data.number,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    stage_name: stage.name,
    assignee_id: assigneeId,
  });
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.created",
    entity: "enquiry",
    entityId: data.id,
    diff: { number: data.number, pipeline_id: pipeline.id },
  });
  const base = { enquiry_id: data.id, number: data.number, title: input.title, actor_id: ctx.userId };
  await emit(ctx.orgId, "enquiry.created", { ...base, pipeline_id: pipeline.id, stage_id: stage.id });
  if (assigneeId) await emit(ctx.orgId, "enquiry.assigned", { ...base, assignee_id: assigneeId, by: assignedBy });

  if (slaDueAt) {
    await scheduleJob({
      kind: "enquiry.sla",
      orgId: ctx.orgId,
      runAt: slaDueAt,
      payload: { enquiry_id: data.id },
      dedupeKey: `enquiry_sla:${data.id}`,
    }).catch((e) => console.error("[enquiries] sla schedule failed", e instanceof Error ? e.message : e));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Update details
// ---------------------------------------------------------------------------

export type EnquiryPatch = {
  title?: string;
  contactId?: string | null;
  channelId?: string | null;
  source?: string | null;
  assigneeId?: string | null;
  estValue?: number | null;
  locationId?: string | null;
  departmentId?: string | null;
  specialistId?: string | null;
  serviceId?: string | null;
  apptDate?: string | null;
  custom?: Record<string, unknown>;
};

const PATCH_COLUMNS: Record<keyof EnquiryPatch, keyof Enquiry> = {
  title: "title",
  contactId: "contact_id",
  channelId: "channel_id",
  source: "source",
  assigneeId: "assignee_id",
  estValue: "est_value",
  locationId: "location_id",
  departmentId: "department_id",
  specialistId: "specialist_id",
  serviceId: "service_id",
  apptDate: "appt_date",
  custom: "custom",
};

export async function updateEnquiry(ctx: Ctx, id: string, patch: EnquiryPatch): Promise<void> {
  const before = await loadEnquiry(ctx, id);
  const update: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(PATCH_COLUMNS) as Array<[keyof EnquiryPatch, keyof Enquiry]>) {
    if (patch[k] !== undefined) update[col] = patch[k];
  }
  const diff = diffFields(before as never, update, Object.keys(update));
  if (Object.keys(diff).length === 0) return;

  const { error } = await ctx.admin
    .from("enquiries")
    .update(update as TablesUpdate<"enquiries">)
    .eq("org_id", ctx.orgId)
    .eq("id", id);
  if (error) throw dbError(error, "Could not save the enquiry.");

  const assigneeChanged = "assignee_id" in diff;
  if (assigneeChanged && ctx.userId && update.assignee_id) await markTouched(ctx.admin, ctx.orgId, id);

  const changed = Object.keys(diff).filter((k) => k !== "custom");
  await timeline(ctx, { id, contact_id: (update.contact_id as string | null | undefined) ?? before.contact_id }, "enquiry.updated", {
    fields: changed,
    custom_changed: "custom" in diff,
    ...(assigneeChanged ? { assignee: diff.assignee_id } : {}),
  } as Json);
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.updated",
    entity: "enquiry",
    entityId: id,
    diff: { fields: Object.keys(diff) },
  });
  if (assigneeChanged && update.assignee_id) {
    await emit(ctx.orgId, "enquiry.assigned", {
      enquiry_id: id,
      number: before.number,
      title: (update.title as string | undefined) ?? before.title,
      assignee_id: update.assignee_id,
      actor_id: ctx.userId,
      by: "user",
    });
  }
}

// ---------------------------------------------------------------------------
// Stage, status, pipeline
// ---------------------------------------------------------------------------

export async function moveStage(ctx: Ctx, id: string, stageId: string): Promise<void> {
  const e = await loadEnquiry(ctx, id);
  if (e.stage_id === stageId) return;
  const [from, to] = await Promise.all([stageInfo(ctx, e.stage_id), stageInfo(ctx, stageId)]);
  if (!to || to.pipeline_id !== e.pipeline_id) throw new EnquiryError("That stage is not in this enquiry's pipeline.");
  const { error } = await ctx.admin.from("enquiries").update({ stage_id: stageId }).eq("org_id", ctx.orgId).eq("id", id);
  if (error) throw dbError(error, "Could not move the enquiry.");
  await markTouched(ctx.admin, ctx.orgId, id);
  await timeline(ctx, e, "enquiry.stage_changed", {
    from_stage_id: e.stage_id,
    from_name: from?.name ?? null,
    to_stage_id: stageId,
    to_name: to.name,
  });
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.stage_changed",
    entity: "enquiry",
    entityId: id,
    diff: { from: e.stage_id, to: stageId },
  });
  await emit(ctx.orgId, "enquiry.stage_changed", {
    enquiry_id: id,
    number: e.number,
    title: e.title,
    assignee_id: e.assignee_id,
    actor_id: ctx.userId,
    pipeline_id: e.pipeline_id,
    from_stage_id: e.stage_id,
    to_stage_id: stageId,
    to_name: to.name,
  });
}

export async function setStatus(ctx: Ctx, id: string, status: EnquiryStatus, reason?: string | null): Promise<void> {
  const e = await loadEnquiry(ctx, id);
  const change = resolveStatusChange({ from: e.status as EnquiryStatus, to: status, reason });
  if (!change.ok) throw new EnquiryError(change.error);
  if (e.status === change.status && (e.lost_reason ?? null) === change.lostReason) return;
  const { error } = await ctx.admin
    .from("enquiries")
    .update({ status: change.status, lost_reason: change.lostReason })
    .eq("org_id", ctx.orgId)
    .eq("id", id);
  if (error) throw dbError(error, "Could not change the status.");
  await markTouched(ctx.admin, ctx.orgId, id);
  await timeline(ctx, e, "enquiry.status_changed", {
    from: e.status,
    to: change.status,
    reason: change.lostReason,
  });
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.status_changed",
    entity: "enquiry",
    entityId: id,
    diff: { from: e.status, to: change.status },
  });
  await emit(ctx.orgId, "enquiry.status_changed", {
    enquiry_id: id,
    number: e.number,
    title: e.title,
    assignee_id: e.assignee_id,
    actor_id: ctx.userId,
    from: e.status,
    to: change.status,
  });
}

/** Moves an enquiry to another pipeline (first stage unless one is given). */
export async function movePipeline(ctx: Ctx, id: string, pipelineId: string, stageId?: string | null): Promise<void> {
  const e = await loadEnquiry(ctx, id);
  if (e.pipeline_id === pipelineId) return;
  const { data: pipeline } = await ctx.admin
    .from("pipelines")
    .select("id, name, archived_at")
    .eq("org_id", ctx.orgId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (!pipeline || pipeline.archived_at) throw new EnquiryError("That pipeline is not available.");
  const stage = stageId ? await stageInfo(ctx, stageId) : await firstStage(ctx, pipelineId);
  if (!stage || stage.pipeline_id !== pipelineId) throw new EnquiryError("That pipeline has no stages yet.");
  const { error } = await ctx.admin
    .from("enquiries")
    .update({ pipeline_id: pipelineId, stage_id: stage.id })
    .eq("org_id", ctx.orgId)
    .eq("id", id);
  if (error) throw dbError(error, "Could not move the enquiry.");
  await markTouched(ctx.admin, ctx.orgId, id);
  await timeline(ctx, e, "enquiry.pipeline_changed", {
    from_pipeline_id: e.pipeline_id,
    to_pipeline_id: pipelineId,
    to_name: pipeline.name,
    to_stage_id: stage.id,
    to_stage_name: stage.name,
  });
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.pipeline_changed",
    entity: "enquiry",
    entityId: id,
    diff: { from: e.pipeline_id, to: pipelineId },
  });
  await emit(ctx.orgId, "enquiry.pipeline_changed", {
    enquiry_id: id,
    number: e.number,
    title: e.title,
    assignee_id: e.assignee_id,
    actor_id: ctx.userId,
    from_pipeline_id: e.pipeline_id,
    to_pipeline_id: pipelineId,
    to_stage_id: stage.id,
  });
}

// ---------------------------------------------------------------------------
// Delete + bulk
// ---------------------------------------------------------------------------

/** Soft-deletes enquiries (they vanish from lists; the audit trail keeps the record). */
export async function deleteEnquiries(ctx: Ctx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await ctx.admin
    .from("enquiries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", ctx.orgId)
    .in("id", ids)
    .is("deleted_at", null)
    .select("id");
  if (error) throw dbError(error, "Could not delete the enquiries.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "enquiry.deleted",
    entity: "enquiry",
    diff: { count: data?.length ?? 0 },
  });
  return data?.length ?? 0;
}

export type BulkOp =
  | { type: "assign"; assigneeId: string | null }
  | { type: "stage"; stageId: string }
  | { type: "status"; status: EnquiryStatus; reason?: string | null }
  | { type: "pipeline"; pipelineId: string; stageId?: string | null }
  | { type: "edit"; patch: Omit<EnquiryPatch, "custom"> };

export type BulkResult = { updated: number; failed: Array<{ id: string; error: string }> };

/** Applies one operation to many enquiries through the single-record paths (so timeline, events and audit stay per enquiry). */
export async function bulkApply(ctx: Ctx, ids: string[], op: BulkOp): Promise<BulkResult> {
  const result: BulkResult = { updated: 0, failed: [] };
  const run = async (id: string) => {
    try {
      switch (op.type) {
        case "assign":
          await updateEnquiry(ctx, id, { assigneeId: op.assigneeId });
          break;
        case "stage":
          await moveStage(ctx, id, op.stageId);
          break;
        case "status":
          await setStatus(ctx, id, op.status, op.reason);
          break;
        case "pipeline":
          await movePipeline(ctx, id, op.pipelineId, op.stageId);
          break;
        case "edit":
          await updateEnquiry(ctx, id, op.patch);
          break;
      }
      result.updated += 1;
    } catch (e) {
      result.failed.push({ id, error: e instanceof EnquiryError ? e.message : "Could not update." });
    }
  };
  const CHUNK = 10;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await Promise.all(ids.slice(i, i + CHUNK).map(run));
  }
  return result;
}
