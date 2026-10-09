"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { isValidCron } from "@/lib/flow-engine/cron";
import { validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import { publishFlow } from "@/lib/flow-engine/publish";
import { finishRun, hashWebhookToken, startRun } from "@/lib/flow-engine/service";
import {
  emptyGraph,
  flowGraphSchema,
  TRIGGER_TYPES,
  type TriggerConfig,
  type TriggerType,
} from "@/lib/flow-engine/types";
import { filterSchema } from "@/lib/filters/ast";
import { checkRateLimit, RATE_RULES } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string; issues?: GraphIssue[] };

const PERM = "flows.manage";
const uuid = z.string().uuid();
const bad = (error = "Invalid input"): { ok: false; error: string } => ({ ok: false, error });
const refresh = () => revalidatePath("/flows");

const triggerConfigSchema = z
  .object({
    channel_id: uuid.optional(),
    pipeline_id: uuid.optional(),
    cron: z.string().trim().max(100).optional(),
    timezone: z.string().trim().max(60).optional(),
    button_ids: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  })
  .strict();

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger_config: triggerConfigSchema.default({}),
  conditions: filterSchema.nullish(),
  channel_id: uuid.nullish(),
});

function checkTrigger(type: TriggerType, cfg: TriggerConfig): string | null {
  if (type === "recurring" && (!cfg.cron || !isValidCron(cfg.cron)))
    return "Enter a valid schedule (five cron fields, e.g. 0 9 * * *).";
  return null;
}

export async function createFlow(
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm(PERM);
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  const d = parsed.data;
  const cfgError = checkTrigger(d.trigger_type, d.trigger_config);
  if (cfgError) return bad(cfgError);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("flows")
    .insert({
      org_id: member.orgId,
      name: d.name,
      description: d.description ?? null,
      trigger_type: d.trigger_type,
      trigger_config: d.trigger_config as unknown as NonNullable<Json>,
      conditions: (d.conditions ?? null) as unknown as Json,
      channel_id: d.channel_id ?? null,
      draft_graph: emptyGraph() as unknown as NonNullable<Json>,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return bad("Could not create the flow.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.created",
    entity: "flow",
    entityId: data.id,
    diff: { trigger: d.trigger_type },
  });
  refresh();
  return { ok: true, data: { id: data.id } };
}

export async function updateFlowSettings(
  id: string,
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const parsed = settingsSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return bad(parsed.success ? undefined : parsed.error.issues[0]?.message);
  const d = parsed.data;
  const cfgError = checkTrigger(d.trigger_type, d.trigger_config);
  if (cfgError) return bad(cfgError);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("flows")
    .update({
      name: d.name,
      description: d.description ?? null,
      trigger_type: d.trigger_type,
      trigger_config: d.trigger_config as unknown as NonNullable<Json>,
      conditions: (d.conditions ?? null) as unknown as Json,
      channel_id: d.channel_id ?? null,
    })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("id");
  if (error || !data?.length) return bad("Could not save the flow.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.updated",
    entity: "flow",
    entityId: id,
    diff: { trigger: d.trigger_type },
  });
  refresh();
  return { ok: true, message: "Saved. Publish to make the change live." };
}

/** Autosave of the canvas. Only the draft changes; running flows keep their published version. */
export async function saveFlowDraft(
  id: string,
  graph: unknown,
): Promise<ActionResult<{ issues: GraphIssue[] }>> {
  const member = await requirePerm(PERM);
  const parsed = flowGraphSchema.safeParse(graph);
  if (!uuid.safeParse(id).success || !parsed.success) return bad("The flow could not be read.");
  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("trigger_type, trigger_config")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) return bad("Flow not found.");
  const { error } = await admin
    .from("flows")
    .update({ draft_graph: parsed.data as unknown as NonNullable<Json> })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return bad("Could not save the draft.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.draft_saved",
    entity: "flow",
    entityId: id,
    diff: { nodes: parsed.data.nodes.length },
  });
  const { data: vars } = await admin
    .from("flow_variables")
    .select("key")
    .eq("org_id", member.orgId);
  const v = validateGraph(parsed.data, {
    triggerType: flow.trigger_type as TriggerType,
    triggerConfig: flow.trigger_config as TriggerConfig,
    knownVariables: (vars ?? []).map((x) => x.key),
  });
  return { ok: true, data: { issues: v.issues } };
}

export async function publishFlowAction(
  id: string,
): Promise<ActionResult<{ version: number; warnings: GraphIssue[] }>> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const res = await publishFlow(admin, member, id);
  if (!res.ok) return { ok: false, error: res.error, issues: res.issues };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.published",
    entity: "flow",
    entityId: id,
    diff: { version: res.version },
  });
  refresh();
  return {
    ok: true,
    message: `Published version ${res.version}.`,
    data: { version: res.version, warnings: res.warnings },
  };
}

export async function setFlowStatus(
  id: string,
  status: "active" | "paused",
): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success || !["active", "paused"].includes(status)) return bad();
  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("version")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) return bad("Flow not found.");
  if (status === "active" && flow.version < 1) return bad("Publish the flow first.");
  await admin.from("flows").update({ status }).eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: status === "active" ? "flow.resumed" : "flow.paused",
    entity: "flow",
    entityId: id,
  });
  refresh();
  return {
    ok: true,
    message:
      status === "active" ? "Flow is live." : "Flow paused. Runs already in progress carry on.",
  };
}

export async function duplicateFlow(id: string): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const { data: f } = await admin
    .from("flows")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!f) return bad("Flow not found.");
  const { data, error } = await admin
    .from("flows")
    .insert({
      org_id: member.orgId,
      name: `${f.name} (copy)`.slice(0, 120),
      description: f.description,
      status: "draft",
      trigger_type: f.trigger_type,
      trigger_config: f.trigger_config,
      conditions: f.conditions,
      channel_id: f.channel_id,
      draft_graph: f.draft_graph,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return bad("Could not duplicate the flow.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.created",
    entity: "flow",
    entityId: data.id,
    diff: { copied_from: id },
  });
  refresh();
  return { ok: true, data: { id: data.id } };
}

export async function deleteFlow(id: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const { data: live } = await admin
    .from("flow_runs")
    .select("id, org_id, conversation_id")
    .eq("org_id", member.orgId)
    .eq("flow_id", id)
    .in("status", ["running", "waiting"]);
  for (const r of live ?? [])
    await finishRun(admin, r, "cancelled", { cancelReason: "flow_deleted" });
  const { error } = await admin.from("flows").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return bad("Could not delete the flow.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.deleted",
    entity: "flow",
    entityId: id,
    diff: { stopped_runs: live?.length ?? 0 },
  });
  refresh();
  return { ok: true, message: "Flow deleted." };
}

/** New secret for the incoming-webhook trigger. Shown once; only its hash is stored. */
export async function regenerateWebhookToken(id: string): Promise<ActionResult<{ token: string }>> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const token = `fh_${randomBytes(24).toString("base64url")}`;
  const { data, error } = await admin
    .from("flows")
    .update({ webhook_token_hash: hashWebhookToken(token) })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("trigger_type", "incoming_webhook")
    .select("id");
  if (error || !data?.length) return bad("Only flows with an incoming-webhook trigger have a URL.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.webhook_token_rotated",
    entity: "flow",
    entityId: id,
  });
  refresh();
  return { ok: true, data: { token } };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const variableSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Letters, digits and _, starting with a letter"),
  label: z.string().trim().max(80).nullish(),
  value_type: z.enum(["text", "number", "boolean"]),
  default_value: z.string().max(500).nullish(),
  description: z.string().trim().max(300).nullish(),
});

export async function saveFlowVariable(
  input: z.input<typeof variableSchema>,
  id?: string,
): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const parsed = variableSchema.safeParse(input);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  const v = parsed.data;
  if (v.value_type === "number" && v.default_value && !Number.isFinite(Number(v.default_value)))
    return bad("The default must be a number.");
  if (v.value_type === "boolean" && v.default_value && !["true", "false"].includes(v.default_value))
    return bad("The default must be true or false.");
  const admin = createAdminClient();
  const row = {
    key: v.key,
    label: v.label ?? null,
    value_type: v.value_type,
    default_value: v.default_value || null,
    description: v.description ?? null,
  };
  const q = id
    ? admin.from("flow_variables").update(row).eq("id", id).eq("org_id", member.orgId)
    : admin.from("flow_variables").insert({ ...row, org_id: member.orgId });
  const { error } = await q;
  if (error)
    return bad(
      error.code === "23505"
        ? "That variable name is already used."
        : "Could not save the variable.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "flow_variable.updated" : "flow_variable.created",
    entity: "flow_variable",
    entityId: id ?? null,
    diff: { key: v.key },
  });
  refresh();
  return { ok: true };
}

export async function deleteFlowVariable(id: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const { error } = await admin
    .from("flow_variables")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return bad("Could not delete the variable.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow_variable.deleted",
    entity: "flow_variable",
    entityId: id,
  });
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function stopFlowRun(runId: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(runId).success) return bad();
  const admin = createAdminClient();
  const { data: run } = await admin
    .from("flow_runs")
    .select("id, org_id, conversation_id, status")
    .eq("id", runId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!run) return bad("Run not found.");
  if (run.status !== "running" && run.status !== "waiting")
    return bad("That run has already finished.");
  await finishRun(admin, run, "cancelled", { cancelReason: "stopped_manually" });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.run_stopped",
    entity: "flow_run",
    entityId: runId,
  });
  refresh();
  return { ok: true, message: "Run stopped." };
}

/** Inbox "Shortcut": a person starts a shortcut flow on a conversation they can see. */
export async function runFlowShortcut(
  conversationId: string,
  flowId: string,
): Promise<ActionResult> {
  const member = await requireMember();
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(flowId).success) return bad();
  if (!can(member, "inbox.send")) return bad("You don't have permission for that.");
  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "flow-shortcut",
    member.userId,
    RATE_RULES.flowShortcutPerUser,
  );
  if (!limited.allowed) return bad("Too many shortcuts in a minute. Wait a moment.");

  // Visibility goes through RLS: the caller must be able to see the conversation.
  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, contact_id, channel_id, status, bot_active")
    .eq("id", conversationId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!conversation) return bad("Conversation not found.");
  if (conversation.status === "closed") return bad("This conversation is closed.");
  if (conversation.bot_active)
    return bad(
      "A bot is already running here. Take the conversation over first, or wait for it to finish.",
    );

  const { data: flow } = await admin
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("org_id", member.orgId)
    .eq("trigger_type", "shortcut")
    .maybeSingle();
  if (!flow || flow.status !== "active") return bad("That shortcut is not available.");
  const cfg = flow.trigger_config as TriggerConfig;
  if (
    (cfg.channel_id ?? flow.channel_id) &&
    (cfg.channel_id ?? flow.channel_id) !== conversation.channel_id
  )
    return bad("That shortcut is for a different number.");

  const res = await startRun(admin, flow, {
    conversationId,
    contactId: conversation.contact_id,
    context: { conversation_id: conversationId, contact_id: conversation.contact_id },
    event: { name: "shortcut", at: new Date().toISOString() },
    startedBy: member.userId,
  });
  if (res.status === "skipped")
    return bad(
      res.reason === "already_running"
        ? "A bot is already running here."
        : "The shortcut could not start.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "flow.shortcut_run",
    entity: "flow",
    entityId: flowId,
    diff: { run: res.runId },
  });
  return { ok: true, message: `Started "${flow.name}".` };
}
