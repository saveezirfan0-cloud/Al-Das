/**
 * One executor per node type. `executeNode(node, env)` returns what should happen next; it never
 * touches the database itself (all effects go through env.ports), so every executor has a plain
 * unit test. A step handles exactly one node.
 */
import { matchesConditions } from "@/lib/flow-engine/conditions";
import { interpolate, stringify } from "@/lib/flow-engine/interpolate";
import { isOfficeOpen } from "@/lib/flow-engine/office-hours";
import { FlowNodeError, type FlowPorts } from "@/lib/flow-engine/ports";
import {
  parseNodeData,
  type FlowNode,
  type FlowOption,
  type NodeData,
  type NodeType,
} from "@/lib/flow-engine/types";

export type Reply = {
  type: string;
  text: string | null;
  /** Interactive button / list row id the patient tapped, when any. */
  interactiveId: string | null;
};

export type StepInput =
  { type: "start" } | { type: "reply"; reply: Reply } | { type: "timeout" } | { type: "time" };

export type ExecEnv = {
  nodeId: string;
  scope: Record<string, unknown>;
  ports: FlowPorts;
  input: StepInput;
};

export type NodeResult =
  | {
      kind: "next";
      handle: string;
      /** Becomes steps.<node>. */
      output?: Record<string, unknown>;
      vars?: Record<string, unknown>;
      /** Ids that later nodes can reach through the scope (enquiry_id, appointment_id…). */
      context?: Record<string, string>;
      detail?: Record<string, unknown>;
      /** Fails the run when this exit has no arrow (used for errors that have a `fallback` exit). */
      failed?: string;
    }
  | { kind: "wait_reply"; timeoutMinutes?: number; detail?: Record<string, unknown> }
  | { kind: "wait_time"; until: Date; detail?: Record<string, unknown> }
  | { kind: "end"; detail?: Record<string, unknown> }
  | { kind: "transfer"; flowId: string };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 } as const;

function i(env: ExecEnv, text: string): string {
  return interpolate(text, env.scope, { timezone: env.ports.timezone });
}

function needConversation(env: ExecEnv, what: string) {
  if (!env.ports.hasConversation)
    throw new FlowNodeError(`${what} needs a conversation, and this run has none.`);
}

type Exec<T extends NodeType> = (data: NodeData<T>, env: ExecEnv) => Promise<NodeResult>;

const next = (
  handle = "default",
  extra: Partial<Extract<NodeResult, { kind: "next" }>> = {},
): NodeResult => ({
  kind: "next",
  handle,
  ...extra,
});

export const executors: { [K in NodeType]: Exec<K> } = {
  async trigger() {
    return next();
  },

  async message(d, env) {
    needConversation(env, "Message");
    const text = i(env, d.text).trim();
    if (!text) throw new FlowNodeError("The message is empty after filling in its fields.");
    await env.ports.sendText(text);
    return next("default", { detail: { sent: true } });
  },

  async question(d, env) {
    const { input } = env;
    if (input.type === "start") {
      needConversation(env, "Question");
      const text = i(env, d.text).trim();
      if (d.kind === "buttons") await env.ports.sendButtons(text, d.options);
      else if (d.kind === "list")
        await env.ports.sendList(text, d.listButtonLabel ?? "Choose", d.options);
      else await env.ports.sendText(text);
      return { kind: "wait_reply", timeoutMinutes: d.timeoutMinutes, detail: { asked: d.kind } };
    }
    if (input.type === "timeout") return next("fallback", { detail: { reason: "timeout" } });
    if (input.type !== "reply") return next("fallback", { detail: { reason: "unexpected_input" } });

    const reply = input.reply;
    if (d.kind === "text") {
      const t = (reply.text ?? "").trim();
      if (reply.type !== "text" || !t) return next("fallback", { detail: { reason: "not_text" } });
      return next("default", {
        vars: { [d.variable]: t.slice(0, 1000) },
        detail: { answered: true },
      });
    }
    const picked = matchOption(d.options, reply);
    if (!picked) return next("fallback", { detail: { reason: "no_match" } });
    return next(`option:${picked.id}`, {
      vars: { [d.variable]: picked.title, [`${d.variable}_id`]: picked.id },
      detail: { option: picked.id },
    });
  },

  async quick_reply(d, env) {
    const { input } = env;
    if (input.type === "start") {
      needConversation(env, "Quick reply");
      await env.ports.sendButtons(i(env, d.text).trim(), d.options);
      return { kind: "wait_reply", timeoutMinutes: d.timeoutMinutes, detail: { asked: "buttons" } };
    }
    if (input.type === "timeout") return next("fallback", { detail: { reason: "timeout" } });
    if (input.type !== "reply") return next("fallback", { detail: { reason: "unexpected_input" } });
    const picked = matchOption(d.options, input.reply);
    if (!picked) return next("fallback", { detail: { reason: "no_match" } });
    return next(`option:${picked.id}`, { detail: { option: picked.id } });
  },

  async template(d, env) {
    needConversation(env, "Template");
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.values)) values[k] = i(env, v);
    await env.ports.sendTemplate(d.templateId, values);
    return next("default", { detail: { template: d.templateId } });
  },

  async branch(d, env) {
    const ok = matchesConditions(d.conditions, env.scope, env.ports.now());
    return next(ok ? "true" : "false", { detail: { result: ok } });
  },

  async wait(d, env) {
    if (env.input.type === "time") return next();
    const until = new Date(env.ports.now().getTime() + d.amount * UNIT_SECONDS[d.unit] * 1000);
    return { kind: "wait_time", until, detail: { amount: d.amount, unit: d.unit } };
  },

  async office_hours(d, env) {
    const tz = d.timezone ?? env.ports.timezone;
    const open = isOfficeOpen(d.days, env.ports.now(), tz);
    return next(open ? "inside" : "outside", { detail: { open } });
  },

  async run_flow(d) {
    return { kind: "transfer", flowId: d.flowId };
  },

  async end_flow() {
    return { kind: "end" };
  },

  async assign_to(d, env) {
    needConversation(env, "Assign to");
    await env.ports.assign({ userId: d.userId, teamId: d.teamId });
    return next("default", { detail: { to: d.userId ? "user" : "team" } });
  },

  async close_conversation(_d, env) {
    needConversation(env, "Close conversation");
    await env.ports.closeConversation();
    return next();
  },

  async add_comment(d, env) {
    needConversation(env, "Add comment");
    const text = i(env, d.text).trim();
    if (!text) throw new FlowNodeError("The comment is empty after filling in its fields.");
    await env.ports.addComment(text);
    return next();
  },

  async update_contact(d, env) {
    const patch: Record<string, string> = {};
    for (const f of d.fields) patch[f.field] = i(env, f.value).trim();
    await env.ports.updateContact(patch);
    return next("default", { detail: { fields: Object.keys(patch) } });
  },

  async enquiry(d, env) {
    const res = await env.ports.upsertEnquiry({
      action: d.action,
      pipelineId: d.pipelineId,
      stageId: d.stageId,
      status: d.status,
      subject: d.subject ? i(env, d.subject) : undefined,
    });
    return next("default", {
      output: { id: res.id },
      context: { enquiry_id: res.id },
      detail: { action: d.action },
    });
  },

  async add_task(d, env) {
    const dueAt = new Date(env.ports.now().getTime() + d.dueInHours * 3600_000);
    const res = await env.ports.createTask({
      subject: i(env, d.subject),
      notes: d.notes ? i(env, d.notes) : undefined,
      dueAt,
      assigneeId: d.assigneeId,
    });
    return next("default", { output: { id: res.id }, detail: { task: true } });
  },

  async portal_record(d, env) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.values)) values[k] = i(env, v);
    const recordId = d.recordId ? i(env, d.recordId).trim() : undefined;
    if (d.action === "update" && !recordId) throw new FlowNodeError("Update needs a record id.");
    const res = await env.ports.portalRecord({
      objectKey: d.objectKey,
      action: d.action,
      recordId,
      values,
    });
    return next("default", {
      output: { id: res.id },
      detail: { object: d.objectKey, action: d.action },
    });
  },

  async appointment(d, env) {
    if (d.action === "set_status") {
      if (!d.status) throw new FlowNodeError("Choose confirmed or cancelled.");
      const id = d.appointmentId ? i(env, d.appointmentId).trim() : undefined;
      const res = await env.ports.appointment({
        action: "set_status",
        status: d.status,
        appointmentId: id || undefined,
      });
      return next("default", { output: { id: res.id }, detail: { status: d.status } });
    }
    const startsRaw = d.startsAt ? i(env, d.startsAt).trim() : "";
    const startsAt = new Date(startsRaw);
    if (!startsRaw || Number.isNaN(startsAt.getTime()))
      throw new FlowNodeError("The appointment start time is missing or not a date.");
    const res = await env.ports.appointment({
      action: "create",
      specialistId: d.specialistId,
      locationId: d.locationId,
      startsAt,
      durationMinutes: d.durationMinutes,
    });
    return next("default", {
      output: { id: res.id },
      context: res.id ? { appointment_id: res.id } : undefined,
      detail: { created: true },
    });
  },

  async api_action(d, env) {
    const url = i(env, d.url).trim();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.headers)) headers[k] = i(env, v);
    try {
      const res = await env.ports.httpRequest({
        method: d.method,
        url,
        headers,
        body: d.body !== undefined ? i(env, d.body) : undefined,
      });
      let response: unknown = res.text;
      try {
        response = JSON.parse(res.text);
      } catch {
        /* keep the text */
      }
      const ok = res.status >= 200 && res.status < 300;
      const vars = d.saveAs ? { [d.saveAs]: res.text.slice(0, 2000) } : undefined;
      if (!ok) {
        return next("fallback", {
          output: { status: res.status, response },
          vars,
          detail: { status: res.status },
          failed: `The API answered ${res.status}.`,
        });
      }
      return next("default", {
        output: { status: res.status, response },
        vars,
        detail: { status: res.status },
      });
    } catch (e) {
      const reason = e instanceof FlowNodeError ? e.message : "The request could not be completed.";
      return next("fallback", { output: { status: 0 }, detail: { error: true }, failed: reason });
    }
  },

  async send_notification(d, env) {
    const n = await env.ports.notify({
      userId: d.userId,
      permission: d.permission,
      title: i(env, d.title),
      body: d.body ? i(env, d.body) : undefined,
    });
    return next("default", { detail: { notified: n } });
  },
};

function matchOption(options: FlowOption[], reply: Reply): FlowOption | null {
  if (reply.interactiveId) {
    const byId = options.find((o) => o.id === reply.interactiveId);
    if (byId) return byId;
  }
  const t = norm(reply.text);
  if (!t) return null;
  return options.find((o) => norm(o.title) === t || norm(o.id) === t) ?? null;
}

/** Parses the node's data with its schema, then runs the executor. Throws FlowNodeError on bad config. */
export async function executeNode(node: FlowNode, env: ExecEnv): Promise<NodeResult> {
  let data: unknown;
  try {
    data = parseNodeData(node.type, node.data);
  } catch {
    throw new FlowNodeError("This step is not configured correctly.");
  }
  const exec = executors[node.type] as unknown as (d: unknown, e: ExecEnv) => Promise<NodeResult>;
  return exec(data, env);
}

export { stringify };
