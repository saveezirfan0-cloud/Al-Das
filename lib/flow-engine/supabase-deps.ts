import "server-only";

import { randomUUID } from "node:crypto";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { emit } from "@/lib/events/emit";
import { crmPort } from "@/lib/flow-engine/crm-registry";
import type {
  ContactView,
  ConversationView,
  FlowActions,
  FlowDeps,
  FlowStore,
  FlowView,
  RunRecord,
  StepRecord,
  TemplateView,
} from "@/lib/flow-engine/deps";
import { guardedHttp } from "@/lib/flow-engine/http-action";
import {
  graphSchema,
  type FlowGraph,
  type RunContext,
  type WaitingFor,
} from "@/lib/flow-engine/types";
import { ensureConversation } from "@/lib/inbox/conversations";
import { resolveChannelId } from "@/lib/inbox/default-channel";
import { addNote, queueOutbound, type SendSpec } from "@/lib/inbox/send";
import { enqueue, scheduleJob } from "@/lib/jobs/enqueue";
import { createNotification } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";

const j = (v: unknown) => v as unknown as NonNullable<Json>;

function toRun(r: Tables<"flow_runs">): RunRecord {
  return {
    id: r.id,
    org_id: r.org_id,
    flow_id: r.flow_id,
    flow_version: r.flow_version,
    contact_id: r.contact_id,
    conversation_id: r.conversation_id,
    enquiry_id: r.enquiry_id,
    status: r.status as RunRecord["status"],
    current_node_id: r.current_node_id,
    context: r.context as unknown as RunContext,
    waiting_for: (r.waiting_for as unknown as WaitingFor | null) ?? null,
    step_count: r.step_count,
    parent_run_id: r.parent_run_id,
    error: r.error,
  };
}

function toStep(s: Tables<"flow_run_steps">): StepRecord {
  return {
    id: s.id,
    run_id: s.run_id,
    seq: s.seq,
    node_id: s.node_id,
    node_type: s.node_type,
    status: s.status as StepRecord["status"],
    input: (s.input as Record<string, unknown> | null) ?? null,
    output: (s.output as Record<string, unknown> | null) ?? null,
    error: s.error,
  };
}

function parseGraph(raw: unknown): FlowGraph | null {
  const r = graphSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function supabaseStore(admin: AdminClient): FlowStore {
  return {
    async getRun(id) {
      const { data } = await admin.from("flow_runs").select("*").eq("id", id).maybeSingle();
      return data ? toRun(data) : null;
    },
    async updateRun(id, patch) {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        row[k] = k === "context" || k === "waiting_for" ? (v === null ? null : j(v)) : v;
      }
      const { error } = await admin
        .from("flow_runs")
        .update(row as never)
        .eq("id", id);
      if (error) throw new Error(`updateRun: ${error.message}`);
    },
    async insertStep(step) {
      const { data, error } = await admin
        .from("flow_run_steps")
        .insert({ ...step, input: step.input === null ? null : j(step.input) })
        .select("*")
        .single();
      if (!error) return { step: toStep(data), created: true };
      if (error.code !== "23505") throw new Error(`insertStep: ${error.message}`);
      const { data: existing, error: e2 } = await admin
        .from("flow_run_steps")
        .select("*")
        .eq("run_id", step.run_id)
        .eq("seq", step.seq)
        .single();
      if (e2) throw new Error(`insertStep(existing): ${e2.message}`);
      return { step: toStep(existing), created: false };
    },
    async updateStep(id, patch) {
      const { error } = await admin
        .from("flow_run_steps")
        .update({
          status: patch.status,
          ...(patch.output !== undefined
            ? { output: patch.output === null ? null : j(patch.output) }
            : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          finished_at: patch.status === "waiting" ? null : new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw new Error(`updateStep: ${error.message}`);
    },
    async finishWaitingStep(runId, nodeId, output) {
      const { data } = await admin
        .from("flow_run_steps")
        .select("id, output")
        .eq("run_id", runId)
        .eq("node_id", nodeId)
        .eq("status", "waiting")
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return;
      await admin
        .from("flow_run_steps")
        .update({
          status: "ok",
          output: j({ ...((data.output as Record<string, unknown> | null) ?? {}), ...output }),
          finished_at: new Date().toISOString(),
        })
        .eq("id", data.id);
    },
    async getGraph(flowId, version) {
      const { data } = await admin
        .from("flow_versions")
        .select("graph")
        .eq("flow_id", flowId)
        .eq("version", version)
        .maybeSingle();
      return data ? parseGraph(data.graph) : null;
    },
    async getFlow(id) {
      const { data } = await admin.from("flows").select("*").eq("id", id).maybeSingle();
      if (!data) return null;
      const view: FlowView = {
        id: data.id,
        org_id: data.org_id,
        name: data.name,
        status: data.status as FlowView["status"],
        trigger_type: data.trigger_type,
        trigger_config: (data.trigger_config as Record<string, unknown>) ?? {},
        channel_id: data.channel_id,
        version: data.version,
        published_graph: data.published_graph ? parseGraph(data.published_graph) : null,
      };
      return view;
    },
    async createRun(input) {
      const { data, error } = await admin
        .from("flow_runs")
        .insert({
          org_id: input.org_id,
          flow_id: input.flow_id,
          flow_version: input.flow_version,
          contact_id: input.contact_id,
          conversation_id: input.conversation_id,
          enquiry_id: input.enquiry_id ?? null,
          current_node_id: input.current_node_id,
          context: j(input.context),
          parent_run_id: input.parent_run_id ?? null,
          started_by: input.started_by ?? null,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") return null; // one live bot run per conversation
        throw new Error(`createRun: ${error.message}`);
      }
      return toRun(data);
    },
    async getContact(id) {
      const { data } = await admin
        .from("contacts")
        .select(
          "id, org_id, first_name, last_name, full_name, email, gender, language, label, stop_marketing, promotions_opt_in, phone_e164, wa_bsuid, custom",
        )
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      const view: ContactView = {
        id: data.id,
        org_id: data.org_id,
        first_name: data.first_name,
        last_name: data.last_name,
        full_name: data.full_name ?? "",
        email: data.email,
        gender: data.gender,
        language: data.language,
        label: data.label,
        stop_marketing: data.stop_marketing,
        promotions_opt_in: data.promotions_opt_in,
        has_phone: Boolean(data.phone_e164 || data.wa_bsuid),
        custom: (data.custom as Record<string, unknown>) ?? {},
      };
      return view;
    },
    async getConversation(id) {
      const { data } = await admin.from("conversations").select("*").eq("id", id).maybeSingle();
      if (!data) return null;
      const view: ConversationView = {
        id: data.id,
        org_id: data.org_id,
        channel_id: data.channel_id,
        contact_id: data.contact_id,
        status: data.status as ConversationView["status"],
        bot_active: data.bot_active,
        flow_run_id: data.flow_run_id,
        last_inbound_at: data.last_inbound_at,
        opened_at: data.opened_at,
        ad_referral: data.ad_referral,
        assignee_user_id: data.assignee_user_id,
        assignee_team_id: data.assignee_team_id,
      };
      return view;
    },
    async getVariables(orgId) {
      const { data } = await admin
        .from("flow_variables")
        .select("key, value")
        .eq("org_id", orgId)
        .eq("enabled", true);
      return Object.fromEntries((data ?? []).map((v) => [v.key, v.value]));
    },
    async getTemplate(orgId, id): Promise<TemplateView | null> {
      const { data } = await admin
        .from("wa_templates")
        .select("*")
        .eq("id", id)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!data) return null;
      return {
        id: data.id,
        name: data.name,
        status: data.status,
        category: data.category,
        components: data.components,
        variable_map: (data.variable_map as Record<string, string>) ?? {},
      };
    },
    async getLiveRunForConversation(conversationId) {
      const { data } = await admin
        .from("flow_runs")
        .select("*")
        .eq("conversation_id", conversationId)
        .is("parent_run_id", null)
        .in("status", ["running", "waiting"])
        .maybeSingle();
      return data ? toRun(data) : null;
    },
    async setConversationBot(conversationId, patch) {
      await admin.from("conversations").update(patch).eq("id", conversationId);
    },
    async listActiveFlows(orgId, triggerType) {
      const { data } = await admin
        .from("flows")
        .select("id")
        .eq("org_id", orgId)
        .eq("trigger_type", triggerType)
        .eq("status", "active")
        .limit(50);
      const out: FlowView[] = [];
      for (const row of data ?? []) {
        const f = await this.getFlow(row.id);
        if (f?.published_graph) out.push(f);
      }
      return out;
    },
    async getInboundMessage(messageId) {
      const { data } = await admin
        .from("messages")
        .select(
          "id, org_id, conversation_id, kind, body, payload, reply_to_wa_message_id, conversations(contact_id)",
        )
        .eq("id", messageId)
        .eq("direction", "in")
        .maybeSingle();
      if (!data) return null;
      const raw = (data.payload ?? {}) as Record<string, unknown>;
      const interactive = raw.interactive as Record<string, { id?: string }> | undefined;
      const button = raw.button as { payload?: string } | undefined;
      const replyId =
        interactive?.button_reply?.id ?? interactive?.list_reply?.id ?? button?.payload ?? null;
      let templateId: string | null = null;
      if (data.kind === "button" && data.reply_to_wa_message_id) {
        const { data: orig } = await admin
          .from("messages")
          .select("payload")
          .eq("org_id", data.org_id)
          .eq("wa_message_id", data.reply_to_wa_message_id)
          .maybeSingle();
        const send = (orig?.payload as { send?: { template_id?: string } } | null)?.send;
        templateId = send?.template_id ?? null;
      }
      return {
        id: data.id,
        conversation_id: data.conversation_id,
        contact_id: data.conversations?.contact_id ?? null,
        kind: data.kind,
        body: data.body,
        reply_id: replyId,
        template_id: templateId,
      };
    },
    async getFirstInboundText(conversationId) {
      const { data } = await admin
        .from("messages")
        .select("body")
        .eq("conversation_id", conversationId)
        .eq("direction", "in")
        .order("at", { ascending: true })
        .limit(1)
        .maybeSingle();
      return data?.body ?? null;
    },
  };
}

export function supabaseActions(admin: AdminClient): FlowActions {
  return {
    async send(run, spec: SendSpec, body) {
      let conversationId = run.conversation_id;
      if (!conversationId) {
        if (!run.contact_id) throw new Error("Run has no contact to message");
        const { data: flow } = await admin
          .from("flows")
          .select("channel_id")
          .eq("id", run.flow_id)
          .maybeSingle();
        const conv = await ensureConversation(
          admin,
          run.org_id,
          run.contact_id,
          await resolveChannelId(admin, run.org_id, flow?.channel_id),
        );
        conversationId = conv.id;
        run.conversation_id = conv.id;
        await admin.from("flow_runs").update({ conversation_id: conv.id }).eq("id", run.id);
      }
      let text = body;
      if (spec.type === "template" && text === null) {
        const { data: tpl } = await admin
          .from("wa_templates")
          .select("components")
          .eq("id", spec.template_id)
          .maybeSingle();
        text = tpl ? renderTemplatePreview(tpl.components as never, spec.values).body : null;
      }
      const message = await queueOutbound(admin, {
        orgId: run.org_id,
        conversationId,
        spec,
        body: text,
        sentByUserId: null,
        flowRunId: run.id,
        priority: false,
      });
      return { messageId: message.id };
    },

    async assign(run, target) {
      if (!run.conversation_id) return;
      const patch =
        target.type === "user"
          ? { assignee_user_id: target.id ?? null, assignee_team_id: null, bot_active: false }
          : target.type === "team"
            ? { assignee_team_id: target.id ?? null, assignee_user_id: null, bot_active: false }
            : target.type === "bot"
              ? { bot_active: true }
              : { assignee_user_id: null, assignee_team_id: null };
      const { error } = await admin
        .from("conversations")
        .update(patch)
        .eq("id", run.conversation_id)
        .eq("org_id", run.org_id);
      if (error) throw new Error(`assign failed: ${error.message}`);
      if (target.type === "user" && target.id) {
        await createNotification(admin, {
          orgId: run.org_id,
          userId: target.id,
          type: "inbox.assigned",
          title: "Conversation assigned to you",
          payload: { conversation_id: run.conversation_id, by: "flow" },
        });
      }
      if (target.type === "user" || target.type === "team") {
        await emit(run.org_id, "conversation.assigned", {
          conversation_id: run.conversation_id,
          user_id: target.type === "user" ? target.id : null,
          team_id: target.type === "team" ? target.id : null,
          by: "flow",
        });
      }
    },

    async closeConversation(run) {
      if (!run.conversation_id) return;
      const { error } = await admin
        .from("conversations")
        .update({ status: "closed", closed_at: new Date().toISOString(), closed_by: null })
        .eq("id", run.conversation_id)
        .eq("org_id", run.org_id);
      if (error) throw new Error(`close failed: ${error.message}`);
      await emit(run.org_id, "conversation.closed", {
        conversation_id: run.conversation_id,
        by: "flow",
      });
    },

    async addComment(run, body) {
      if (!run.conversation_id) return;
      await addNote(admin, {
        orgId: run.org_id,
        conversationId: run.conversation_id,
        body,
        userId: null,
      });
    },

    async updateContactField(run, field, value) {
      if (!run.contact_id) return;
      if (field.startsWith("custom.")) {
        const key = field.slice("custom.".length);
        const { data } = await admin
          .from("contacts")
          .select("custom")
          .eq("id", run.contact_id)
          .eq("org_id", run.org_id)
          .single();
        const custom = { ...((data?.custom as Record<string, unknown>) ?? {}), [key]: value };
        const { error } = await admin
          .from("contacts")
          .update({ custom: j(custom) })
          .eq("id", run.contact_id)
          .eq("org_id", run.org_id);
        if (error) throw new Error(`contact update failed: ${error.message}`);
      } else {
        const { error } = await admin
          .from("contacts")
          .update({ [field]: value === "" ? null : value } as never)
          .eq("id", run.contact_id)
          .eq("org_id", run.org_id);
        if (error) throw new Error(`contact update failed: ${error.message}`);
      }
      await addTimelineEvent(admin, {
        orgId: run.org_id,
        contactId: run.contact_id,
        type: "contact.updated",
        actorType: "system",
        payload: { fields: [field], by: "flow", flow_run_id: run.id },
      });
    },

    async notify(run, target, title, body) {
      let userIds: string[] = [];
      if (target.type === "user" && target.id) userIds = [target.id];
      if (target.type === "team" && target.id) {
        const { data } = await admin
          .from("team_members")
          .select("user_id")
          .eq("team_id", target.id)
          .eq("org_id", run.org_id);
        userIds = (data ?? []).map((r) => r.user_id);
      }
      if (target.type === "role" && target.id) {
        const { data } = await admin
          .from("memberships")
          .select("user_id, roles!inner(name)")
          .eq("org_id", run.org_id)
          .eq("status", "active")
          .eq("roles.name", target.id);
        userIds = (data ?? []).map((r) => r.user_id);
      }
      for (const userId of userIds) {
        await createNotification(admin, {
          orgId: run.org_id,
          userId,
          type: "flow.notification",
          title,
          body: body || null,
          payload: { flow_run_id: run.id, conversation_id: run.conversation_id },
        });
      }
      return userIds.length;
    },

    http: guardedHttp,
  };
}

export function createFlowDeps(admin: AdminClient): FlowDeps {
  return {
    store: supabaseStore(admin),
    actions: supabaseActions(admin),
    jobs: {
      async enqueueStep(runId, opts) {
        await enqueue(
          "flow_steps",
          { type: "step", run_id: runId },
          { delaySeconds: opts?.delaySeconds },
        );
      },
      async scheduleResume({ orgId, runId, token, runAt }) {
        await scheduleJob({
          kind: "flow.resume",
          orgId,
          runAt,
          payload: { run_id: runId, token },
          dedupeKey: `flow.resume:${runId}:${token}`,
        });
      },
    },
    lock: {
      async claim(key, owner) {
        const { data, error } = await admin.rpc("claim_flow_lock", {
          p_key: key,
          p_owner: owner,
          p_ttl_seconds: 60,
        });
        if (error) throw new Error(`claim_flow_lock: ${error.message}`);
        return Boolean(data);
      },
      async release(key, owner) {
        await admin.rpc("release_flow_lock", { p_key: key, p_owner: owner });
      },
    },
    crm: crmPort(),
    now: () => new Date(),
    uuid: () => randomUUID(),
    timezone: "Asia/Dubai",
  };
}
