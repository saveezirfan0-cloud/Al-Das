"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { isValidCron } from "@/lib/cron";
import { hasErrors, validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import { starterFlow } from "@/lib/flow-engine/starter-flows";
import { graphSchema, TRIGGER_TYPES, triggerConditionsSchema } from "@/lib/flow-engine/types";
import { newWebhookToken } from "@/lib/flow-engine/webhook-token";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T = undefined> = { ok: true; message?: string; data: T } | { ok: false; error: string; issues?: GraphIssue[] };

const uuid = z.string().uuid();
const j = (v: unknown) => v as unknown as NonNullable<Json>;
const EMPTY_GRAPH = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} }], edges: [] };

function refresh(id?: string) {
  revalidatePath("/flows");
  if (id) revalidatePath(`/flows/${id}`);
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  trigger_type: z.enum(TRIGGER_TYPES).default("shortcut"),
  /** Optional starter flow key (see lib/flow-engine/starter-flows.ts); its trigger and steps replace the blank flow. */
  starter: z.string().max(60).optional(),
});

export async function createFlow(input: z.input<typeof createSchema>): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("flows.manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const starter = parsed.data.starter ? starterFlow(parsed.data.starter) : undefined;
  if (parsed.data.starter && !starter) return { ok: false, error: "That starter flow does not exist." };
  const triggerType = starter?.trigger_type ?? parsed.data.trigger_type;
  const triggerConfig = triggerType === "webhook" ? { webhook_token_hash: newWebhookToken().hash } : (starter?.trigger_config ?? {});
  const { data, error } = await admin
    .from("flows")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      description: starter?.description ?? null,
      trigger_type: triggerType,
      trigger_config: j(triggerConfig),
      graph: j(starter?.graph ?? EMPTY_GRAPH),
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not create the flow." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "flow.created", entity: "flow", entityId: data.id, diff: { name: parsed.data.name } });
  refresh();
  return { ok: true, data: { id: data.id } };
}

const draftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullish(),
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  channel_id: uuid.nullish(),
  graph: graphSchema,
});

/** Validates trigger_config for the chosen trigger; keeps the stored webhook token hash (never accepted from the client). */
function cleanTriggerConfig(type: string, raw: Record<string, unknown>, stored: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const value: Record<string, unknown> = {};
  const cond = triggerConditionsSchema.safeParse(raw.conditions ?? {});
  if (!cond.success) return { ok: false, error: "Trigger conditions are invalid" };
  if (["conversation_opened", "conversation_closed", "conversation_waiting", "template_button"].includes(type)) value.conditions = cond.data;
  if (type === "template_button") {
    if (typeof raw.template_id === "string" && raw.template_id) value.template_id = raw.template_id;
    if (typeof raw.button_text === "string" && raw.button_text.trim()) value.button_text = raw.button_text.trim().slice(0, 40);
  }
  if (type === "recurring") {
    if (typeof raw.cron !== "string" || !isValidCron(raw.cron)) return { ok: false, error: "Enter a valid schedule (cron) for the recurring trigger" };
    value.cron = raw.cron.trim();
    value.timezone = typeof raw.timezone === "string" ? raw.timezone : "Asia/Dubai";
    if (typeof raw.segment_id === "string" && raw.segment_id) value.segment_id = raw.segment_id;
  }
  if (type === "webhook" && typeof stored.webhook_token_hash === "string") value.webhook_token_hash = stored.webhook_token_hash;
  return { ok: true, value };
}

export async function saveFlowDraft(id: string, input: z.input<typeof draftSchema>): Promise<ActionResult<{ issues: GraphIssue[] }>> {
  const member = await requirePerm("flows.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Flow not found" };
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid flow" };
  const admin = createAdminClient();
  const { data: flow } = await admin.from("flows").select("id, trigger_config").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!flow) return { ok: false, error: "Flow not found" };
  const cfg = cleanTriggerConfig(parsed.data.trigger_type, parsed.data.trigger_config, (flow.trigger_config as Record<string, unknown>) ?? {});
  if (!cfg.ok) return { ok: false, error: cfg.error };
  if (parsed.data.channel_id) {
    const { data: ch } = await admin.from("channels").select("id").eq("id", parsed.data.channel_id).eq("org_id", member.orgId).maybeSingle();
    if (!ch) return { ok: false, error: "Number not found" };
  }
  const { error } = await admin
    .from("flows")
    .update({
      name: parsed.data.name,
      description: parsed.data.description || null,
      trigger_type: parsed.data.trigger_type,
      trigger_config: j(cfg.value),
      channel_id: parsed.data.channel_id ?? null,
      graph: j(parsed.data.graph),
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the flow." };
  refresh(id);
  return { ok: true, message: "Draft saved.", data: { issues: validateGraph(parsed.data.graph).issues } };
}

export async function publishFlow(id: string): Promise<ActionResult<{ version: number }>> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { data: flow } = await admin.from("flows").select("*").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!flow) return { ok: false, error: "Flow not found" };
  const check = validateGraph(flow.graph);
  if (!check.graph || hasErrors(check.issues)) return { ok: false, error: "Fix the errors in the flow before publishing.", issues: check.issues };
  if (flow.trigger_type === "recurring" && !isValidCron(String((flow.trigger_config as Record<string, unknown>).cron ?? ""))) return { ok: false, error: "Set a valid schedule for the recurring trigger first." };
  const version = flow.version + 1;
  const { error: vErr } = await admin.from("flow_versions").insert({ flow_id: flow.id, version, org_id: member.orgId, graph: j(check.graph), published_by: member.userId });
  if (vErr) return { ok: false, error: "Could not publish (version conflict). Try again." };
  const { error } = await admin
    .from("flows")
    .update({ status: "active", version, published_graph: j(check.graph), published_at: new Date().toISOString() })
    .eq("id", flow.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not publish the flow." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "flow.published", entity: "flow", entityId: flow.id, diff: { version } });
  refresh(id);
  return { ok: true, message: `Published version ${version}. New runs use it; running ones finish on their own version.`, data: { version } };
}

export async function setFlowStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { data: flow } = await admin.from("flows").select("id, version, published_graph").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!flow) return { ok: false, error: "Flow not found" };
  if (status === "active" && (!flow.published_graph || flow.version === 0)) return { ok: false, error: "Publish the flow first." };
  await admin.from("flows").update({ status }).eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: `flow.${status === "active" ? "resumed" : "paused"}`, entity: "flow", entityId: id });
  refresh(id);
  return { ok: true, message: status === "active" ? "Flow is active." : "Flow paused. Running conversations finish; no new runs start.", data: undefined };
}

export async function duplicateFlow(id: string): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { data: f } = await admin.from("flows").select("*").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!f) return { ok: false, error: "Flow not found" };
  const cfg = { ...((f.trigger_config as Record<string, unknown>) ?? {}) };
  delete cfg.webhook_token_hash; // a copy gets its own token
  if (f.trigger_type === "webhook") cfg.webhook_token_hash = newWebhookToken().hash;
  const { data, error } = await admin
    .from("flows")
    .insert({ org_id: member.orgId, name: `${f.name} (copy)`, description: f.description, trigger_type: f.trigger_type, trigger_config: j(cfg), channel_id: f.channel_id, graph: f.graph, created_by: member.userId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not duplicate the flow." };
  refresh();
  return { ok: true, message: "Duplicated as a draft.", data: { id: data.id } };
}

export async function deleteFlow(id: string): Promise<ActionResult> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { data: live } = await admin.from("flow_runs").select("id").eq("flow_id", id).eq("org_id", member.orgId).in("status", ["running", "waiting"]).limit(1);
  if (live?.length) return { ok: false, error: "This flow has conversations in progress. Pause it and let them finish first." };
  const { data, error } = await admin.from("flows").delete().eq("id", id).eq("org_id", member.orgId).select("name");
  if (error || !data?.length) return { ok: false, error: "Could not delete the flow." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "flow.deleted", entity: "flow", entityId: id, diff: { name: data[0]!.name } });
  refresh();
  return { ok: true, message: "Flow deleted.", data: undefined };
}

/** Shown once: only the hash is stored. */
export async function regenerateWebhookToken(id: string): Promise<ActionResult<{ token: string; url_path: string }>> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { data: f } = await admin.from("flows").select("id, trigger_type, trigger_config").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!f || f.trigger_type !== "webhook") return { ok: false, error: "Not an incoming-webhook flow" };
  const { token, hash } = newWebhookToken();
  await admin.from("flows").update({ trigger_config: j({ ...(f.trigger_config as Record<string, unknown>), webhook_token_hash: hash }) }).eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "flow.webhook_token_rotated", entity: "flow", entityId: id });
  refresh(id);
  return { ok: true, message: "New token created. Copy it now — it is not shown again.", data: { token, url_path: `/api/webhooks/in/${id}` } };
}

// ---------------------------------------------------------------------------
// Workspace variables ({vars.KEY})
// ---------------------------------------------------------------------------

const variableSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "Use letters, digits and underscores; start with a letter"),
  value: z.string().max(2000),
  enabled: z.boolean().default(true),
});

export async function saveVariable(id: string | null, input: z.input<typeof variableSchema>): Promise<ActionResult> {
  const member = await requirePerm("flows.manage");
  const parsed = variableSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid variable" };
  const admin = createAdminClient();
  const { error } = id
    ? await admin.from("flow_variables").update(parsed.data).eq("id", id).eq("org_id", member.orgId)
    : await admin.from("flow_variables").insert({ org_id: member.orgId, ...parsed.data });
  if (error) return { ok: false, error: error.code === "23505" ? "A variable with that name already exists." : "Could not save the variable." };
  revalidatePath("/flows/variables");
  return { ok: true, message: "Variable saved.", data: undefined };
}

export async function deleteVariable(id: string): Promise<ActionResult> {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const { error } = await admin.from("flow_variables").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the variable." };
  revalidatePath("/flows/variables");
  return { ok: true, message: "Variable deleted.", data: undefined };
}
