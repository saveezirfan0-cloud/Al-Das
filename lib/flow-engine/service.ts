import "server-only";

import { createHash } from "node:crypto";

import { cronMatches, minuteKey } from "@/lib/flow-engine/cron";
import { matchesConditions } from "@/lib/flow-engine/conditions";
import { firstNodeId } from "@/lib/flow-engine/runner";
import { graphNeedsConversation } from "@/lib/flow-engine/graph";
import { buildScope, orgTimezone, type RunRow } from "@/lib/flow-engine/scope";
import {
  configMatches,
  eventTriggerKey,
  triggerTypesFor,
  trimEvent,
  type EventPayload,
} from "@/lib/flow-engine/triggers";
import {
  flowGraphSchema,
  MAX_RUN_DEPTH,
  type FlowGraph,
  type TriggerConfig,
} from "@/lib/flow-engine/types";
import { ensureConversation } from "@/lib/inbox/conversations";
import { enqueue } from "@/lib/jobs/enqueue";
import { normalizePhone } from "@/lib/phone";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";

export type FlowRow = Tables<"flows">;
export type StepJob = {
  type: "step";
  run_id: string;
  /** The run's step_count when the job was queued; a mismatch means the job is stale or a duplicate. */
  expect: number;
  token?: number;
  input:
    | { type: "start" }
    | { type: "timeout" }
    | { type: "time" }
    | {
        type: "reply";
        reply: { type: string; text: string | null; interactiveId: string | null };
        message_id?: string;
      };
};
export type EventJob = { type: "event"; org_id: string; name: string; payload: Json; at: string };
export type FlowJob = StepJob | EventJob;

/** More than this many runs of one flow for one patient inside a minute is a loop, not a conversation. */
export const LOOP_GUARD_RUNS = 5;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function loadGraph(
  admin: AdminClient,
  flowId: string,
  version: number,
): Promise<FlowGraph | null> {
  const { data } = await admin
    .from("flow_versions")
    .select("graph")
    .eq("flow_id", flowId)
    .eq("version", version)
    .maybeSingle();
  if (!data) return null;
  const parsed = flowGraphSchema.safeParse(data.graph);
  return parsed.success ? parsed.data : null;
}

export async function enqueueStep(job: StepJob, delaySeconds = 0): Promise<void> {
  await enqueue("flow_steps", job as unknown as Json, { delaySeconds });
}

async function variableDefaults(
  admin: AdminClient,
  orgId: string,
): Promise<Record<string, unknown>> {
  const { data } = await admin
    .from("flow_variables")
    .select("key, value_type, default_value")
    .eq("org_id", orgId);
  const out: Record<string, unknown> = {};
  for (const v of data ?? []) {
    if (v.default_value === null) continue;
    out[v.key] =
      v.value_type === "number"
        ? Number.isFinite(Number(v.default_value))
          ? Number(v.default_value)
          : 0
        : v.value_type === "boolean"
          ? v.default_value === "true"
          : v.default_value;
  }
  return out;
}

export type StartOptions = {
  conversationId?: string | null;
  contactId?: string | null;
  context?: Record<string, string>;
  event?: Record<string, unknown>;
  triggerKey?: string | null;
  startedBy?: string | null;
  parentRunId?: string | null;
  depth?: number;
};

export type StartResult =
  { status: "started"; runId: string } | { status: "skipped"; reason: string };

export async function startRun(
  admin: AdminClient,
  flow: FlowRow,
  o: StartOptions = {},
): Promise<StartResult> {
  if (flow.version < 1) return { status: "skipped", reason: "not_published" };
  if (flow.status !== "active") return { status: "skipped", reason: "not_active" };
  if ((o.depth ?? 0) > MAX_RUN_DEPTH) return { status: "skipped", reason: "too_deep" };

  if (o.contactId) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin
      .from("flow_runs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", flow.org_id)
      .eq("flow_id", flow.id)
      .eq("contact_id", o.contactId)
      .gte("started_at", since);
    if ((count ?? 0) >= LOOP_GUARD_RUNS) {
      console.error("[flows] loop guard: too many runs for one patient", { flow: flow.id });
      return { status: "skipped", reason: "loop_guard" };
    }
  }

  const graph = await loadGraph(admin, flow.id, flow.version);
  if (!graph) return { status: "skipped", reason: "no_graph" };
  const first = firstNodeId(graph);
  const now = new Date().toISOString();

  const { data: run, error } = await admin
    .from("flow_runs")
    .insert({
      org_id: flow.org_id,
      flow_id: flow.id,
      flow_version: flow.version,
      status: first ? "running" : "completed",
      conversation_id: o.conversationId ?? null,
      contact_id: o.contactId ?? null,
      context: (o.context ?? {}) as Json as NonNullable<Json>,
      event: (o.event ?? {}) as Json as NonNullable<Json>,
      vars: (await variableDefaults(admin, flow.org_id)) as Json as NonNullable<Json>,
      current_node_id: first,
      trigger_key: o.triggerKey ?? null,
      parent_run_id: o.parentRunId ?? null,
      depth: o.depth ?? 0,
      started_by: o.startedBy ?? null,
      finished_at: first ? null : now,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505")
      return {
        status: "skipped",
        reason: /trigger_key/.test(error.message) ? "duplicate_trigger" : "already_running",
      };
    throw new Error(`startRun: ${error.code}`);
  }
  if (o.conversationId && first) {
    await admin
      .from("conversations")
      .update({ flow_run_id: run.id, bot_active: true })
      .eq("id", o.conversationId)
      .eq("org_id", flow.org_id);
  }
  if (first)
    await enqueueStep({ type: "step", run_id: run.id, expect: 0, input: { type: "start" } });
  return { status: "started", runId: run.id };
}

export async function finishRun(
  admin: AdminClient,
  run: Pick<RunRow, "id" | "org_id" | "conversation_id">,
  status: "completed" | "failed" | "cancelled",
  note?: { error?: string; cancelReason?: string },
): Promise<void> {
  await admin
    .from("flow_runs")
    .update({
      status,
      error: note?.error ?? null,
      cancel_reason: note?.cancelReason ?? null,
      finished_at: new Date().toISOString(),
      wait: null,
    })
    .eq("id", run.id)
    .eq("org_id", run.org_id)
    .in("status", ["running", "waiting"]);
  if (run.conversation_id) {
    await admin
      .from("conversations")
      .update({ flow_run_id: null, bot_active: false })
      .eq("id", run.conversation_id)
      .eq("org_id", run.org_id)
      .eq("flow_run_id", run.id);
  }
}

/** Human takeover / close / manual stop: cancels the live bot run on a conversation. Returns how many were stopped. */
export async function cancelConversationRuns(
  admin: AdminClient,
  orgId: string,
  conversationId: string,
  reason: string,
  exceptRunId?: string,
): Promise<number> {
  let q = admin
    .from("flow_runs")
    .select("id, org_id, conversation_id")
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .in("status", ["running", "waiting"]);
  if (exceptRunId) q = q.neq("id", exceptRunId);
  const { data } = await q;
  for (const r of data ?? []) await finishRun(admin, r, "cancelled", { cancelReason: reason });
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

type Entities = {
  contactId: string | null;
  conversationId: string | null;
  channelId: string | null;
  context: Record<string, string>;
};

async function resolveEntities(
  admin: AdminClient,
  orgId: string,
  p: EventPayload,
): Promise<Entities> {
  const context: Record<string, string> = {};
  let contactId = str(p.contact_id);
  const conversationId = str(p.conversation_id);
  let channelId = str(p.channel_id);
  const messageId = str(p.message_id);
  if (messageId) context.message_id = messageId;

  if (conversationId) {
    context.conversation_id = conversationId;
    const { data } = await admin
      .from("conversations")
      .select("contact_id, channel_id")
      .eq("id", conversationId)
      .eq("org_id", orgId)
      .maybeSingle();
    contactId = contactId ?? data?.contact_id ?? null;
    channelId = channelId ?? data?.channel_id ?? null;
  }
  const enquiryId = str(p.enquiry_id);
  if (enquiryId) {
    context.enquiry_id = enquiryId;
    if (!contactId || !channelId) {
      const { data } = await admin
        .from("enquiries")
        .select("contact_id, channel_id")
        .eq("id", enquiryId)
        .eq("org_id", orgId)
        .maybeSingle();
      contactId = contactId ?? data?.contact_id ?? null;
      channelId = channelId ?? data?.channel_id ?? null;
    }
  }
  const appointmentId = str(p.appointment_id);
  if (appointmentId) {
    context.appointment_id = appointmentId;
    if (!contactId || !channelId) {
      const { data } = await admin
        .from("appointments")
        .select("contact_id, channel_id")
        .eq("id", appointmentId)
        .eq("org_id", orgId)
        .maybeSingle();
      contactId = contactId ?? data?.contact_id ?? null;
      channelId = channelId ?? data?.channel_id ?? null;
    }
  }
  if (contactId) context.contact_id = contactId;
  return { contactId, conversationId, channelId, context };
}

function eventFor(name: string, payload: EventPayload, at: string): Record<string, unknown> {
  const referral = obj(payload.ad_referral);
  const hasAd = Object.keys(referral).length > 0;
  return trimEvent(payload, {
    name,
    at,
    ad: hasAd,
    ad_headline: str(referral.headline) ?? "",
    source: hasAd ? "ad" : (str(payload.source) ?? ""),
  });
}

/** Resume a run that is waiting for this conversation's next message. Returns true when a run took it. */
export async function resumeFromMessage(
  admin: AdminClient,
  orgId: string,
  p: EventPayload,
): Promise<boolean> {
  const conversationId = str(p.conversation_id);
  const messageId = str(p.message_id);
  if (!conversationId || p.kind === "reaction") return false;
  const { data: run } = await admin
    .from("flow_runs")
    .select("id, step_count, wait")
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("status", "waiting")
    .maybeSingle();
  const wait = obj(run?.wait);
  if (!run || wait.type !== "reply" || typeof wait.token !== "number") return false;

  let text: string | null = null;
  if (messageId) {
    const { data: m } = await admin
      .from("messages")
      .select("body")
      .eq("id", messageId)
      .eq("org_id", orgId)
      .maybeSingle();
    text = m?.body ?? null;
  }
  const interactive = obj(p.interactive);
  const kind = str(p.kind) ?? "text";
  await enqueueStep({
    type: "step",
    run_id: run.id,
    expect: run.step_count,
    token: wait.token,
    input: {
      type: "reply",
      reply: {
        type: interactive.id ? "interactive" : kind,
        text: text ?? str(interactive.title),
        interactiveId: str(interactive.id),
      },
      message_id: messageId ?? undefined,
    },
  });
  return true;
}

export async function dispatchEvent(
  admin: AdminClient,
  ev: EventJob,
): Promise<{ started: number; skipped: number; resumed: boolean }> {
  const payload = obj(ev.payload);
  const result = { started: 0, skipped: 0, resumed: false };

  if (ev.name === "conversation.closed" && !str(payload.by_flow_run)) {
    const cid = str(payload.conversation_id);
    if (cid) await cancelConversationRuns(admin, ev.org_id, cid, "conversation_closed");
  }
  if (ev.name === "message.received") {
    result.resumed = await resumeFromMessage(admin, ev.org_id, payload);
    if (result.resumed) return result;
  }

  const types = triggerTypesFor(ev.name, payload);
  if (types.length === 0) return result;

  const { data: flows } = await admin
    .from("flows")
    .select("*")
    .eq("org_id", ev.org_id)
    .eq("status", "active")
    .gte("version", 1)
    .in("trigger_type", types);
  if (!flows?.length) return result;

  const entities = await resolveEntities(admin, ev.org_id, payload);
  const event = eventFor(ev.name, payload, ev.at);

  for (const flow of flows) {
    if (!configMatches(flow.trigger_config as TriggerConfig, entities.channelId, payload)) continue;

    const { scope } = await buildScope(admin, {
      org_id: ev.org_id,
      contact_id: entities.contactId,
      conversation_id: entities.conversationId,
      context: entities.context as Json as NonNullable<Json>,
      event: event as Json as NonNullable<Json>,
      vars: {},
      steps: {},
    });
    const filter = flow.conditions ? (flow.conditions as never) : null;
    if (!matchesConditions(filter, scope)) continue;

    let conversationId = entities.conversationId;
    if (!conversationId && entities.contactId && (flow.channel_id ?? entities.channelId)) {
      const graph = await loadGraph(admin, flow.id, flow.version);
      if (graph && graphNeedsConversation(graph)) {
        try {
          conversationId = (
            await ensureConversation(
              admin,
              ev.org_id,
              entities.contactId,
              (flow.channel_id ?? entities.channelId)!,
            )
          ).id;
        } catch {
          conversationId = null;
        }
      }
    }
    const r = await startRun(admin, flow, {
      conversationId,
      contactId: entities.contactId,
      context: {
        ...entities.context,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      },
      event,
      triggerKey: eventTriggerKey(ev.name, payload, ev.at),
    });
    if (r.status === "started") result.started++;
    else result.skipped++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recurring triggers and recovery
// ---------------------------------------------------------------------------

export async function runRecurring(
  admin: AdminClient,
  now = new Date(),
): Promise<{ checked: number; started: number }> {
  const { data: flows } = await admin
    .from("flows")
    .select("*")
    .eq("status", "active")
    .eq("trigger_type", "recurring")
    .gte("version", 1);
  let started = 0;
  const tzCache = new Map<string, string>();
  for (const flow of flows ?? []) {
    const cfg = flow.trigger_config as TriggerConfig;
    if (!cfg.cron) continue;
    let tz = cfg.timezone;
    if (!tz) {
      if (!tzCache.has(flow.org_id))
        tzCache.set(flow.org_id, await orgTimezone(admin, flow.org_id));
      tz = tzCache.get(flow.org_id)!;
    }
    let due = false;
    try {
      due = cronMatches(cfg.cron, now, tz);
    } catch {
      continue; // an invalid schedule is caught at publish; skip rather than fail the whole tick
    }
    if (!due) continue;
    const r = await startRun(admin, flow, {
      event: { name: "recurring", at: now.toISOString() },
      triggerKey: `cron:${minuteKey(now, tz)}`,
    });
    if (r.status === "started") started++;
  }
  return { checked: flows?.length ?? 0, started };
}

/** Runs whose "next step" job was lost (worker crash between saving a step and queueing the next). */
export async function sweepStuckRuns(admin: AdminClient, olderThanSeconds = 180): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
  const { data } = await admin
    .from("flow_runs")
    .select("id, step_count")
    .eq("status", "running")
    .lt("updated_at", cutoff)
    .limit(100);
  for (const r of data ?? [])
    await enqueueStep({
      type: "step",
      run_id: r.id,
      expect: r.step_count,
      input: { type: "start" },
    });
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Incoming webhook trigger
// ---------------------------------------------------------------------------

export const hashWebhookToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function startFromWebhook(
  admin: AdminClient,
  flow: FlowRow,
  body: Record<string, unknown>,
  idempotencyKey?: string | null,
): Promise<StartResult> {
  let contactId: string | null = null;
  const phoneRaw = str(body.phone) ?? str(body.contact_phone) ?? str(body.mobile);
  if (phoneRaw) {
    const n = normalizePhone(phoneRaw);
    if (n) {
      const { data } = await admin
        .from("contacts")
        .select("id")
        .eq("org_id", flow.org_id)
        .eq("phone_e164", n.e164)
        .is("deleted_at", null)
        .maybeSingle();
      contactId = data?.id ?? null;
    }
  }
  let conversationId: string | null = null;
  if (contactId && flow.channel_id) {
    const graph = await loadGraph(admin, flow.id, flow.version);
    if (graph && graphNeedsConversation(graph)) {
      try {
        conversationId = (await ensureConversation(admin, flow.org_id, contactId, flow.channel_id))
          .id;
      } catch {
        conversationId = null;
      }
    }
  }
  return startRun(admin, flow, {
    contactId,
    conversationId,
    context: {
      ...(contactId ? { contact_id: contactId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
    },
    event: { name: "incoming_webhook", at: new Date().toISOString(), body: trimEvent(body) },
    triggerKey: idempotencyKey ? `hook:${idempotencyKey.slice(0, 120)}` : null,
  });
}
