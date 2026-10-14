import "server-only";

import { processIntentJob } from "@/lib/ai/intent/job";
import { readCopilotSettings, tagMayStartFlows } from "@/lib/ai/copilot/settings";
import { readAiSettings } from "@/lib/ai/settings";
import type { MemberLike } from "@/lib/auth/can";
import { createAppointment } from "@/lib/appointments/service";
import { loadCustomFields } from "@/lib/contacts/server";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import { mergeEnquiryCustom } from "@/lib/enquiries/custom";
import {
  createEnquiry,
  movePipeline,
  moveStage,
  setStatus,
  updateEnquiry,
} from "@/lib/enquiries/service";
import type { CrmPort, RunRecord } from "@/lib/flow-engine/deps";
import { queueCapiEvent } from "@/lib/integrations/capi/server";
import { createPaymentRequest } from "@/lib/integrations/payments/request-server";
import { getPortalObject } from "@/lib/portal/objects";
import { createRecord, updateRecord } from "@/lib/portal/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { TaskType } from "@/lib/tasks/constants";
import { createTask } from "@/lib/tasks/service";

/**
 * G0 (Phase 20b): the production adapters behind the flow engine's CRM / integration / AI ports.
 *
 * Built per job from the admin client by createFlowDeps (lib/flow-engine/supabase-deps.ts), so they cannot be "not
 * registered" and nothing depends on import order. Every write goes through the module's own service (the same code the
 * screens use), so validation, audit, timeline and domain events cannot be skipped; each service emits its event once.
 * The actor is the system (userId null), except portal records, which run with the CURRENT permissions of the person who
 * published the flow version (re-checked on every step; if they lost the permission the step fails closed).
 *
 * `services` is injectable for unit tests (tests/unit/flow-crm-adapters.test.ts).
 */
export type CrmServices = {
  createEnquiry: typeof createEnquiry;
  updateEnquiry: typeof updateEnquiry;
  moveStage: typeof moveStage;
  movePipeline: typeof movePipeline;
  setStatus: typeof setStatus;
  createTask: typeof createTask;
  createRecord: typeof createRecord;
  updateRecord: typeof updateRecord;
  createAppointment: typeof createAppointment;
  createPaymentRequest: typeof createPaymentRequest;
  queueCapiEvent: typeof queueCapiEvent;
  processIntentJob: typeof processIntentJob;
  loadEnquiryCustomFields: (
    admin: AdminClient,
    orgId: string,
  ) => ReturnType<typeof loadCustomFields>;
};

function defaultServices(): CrmServices {
  return {
    createEnquiry,
    updateEnquiry,
    moveStage,
    movePipeline,
    setStatus,
    createTask,
    createRecord,
    updateRecord,
    createAppointment,
    createPaymentRequest,
    queueCapiEvent,
    processIntentJob,
    loadEnquiryCustomFields: (admin, orgId) => loadCustomFields(admin, orgId, "enquiry"),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function boolish(v: string): boolean | string {
  const t = v.trim().toLowerCase();
  if (["true", "yes", "1"].includes(t)) return true;
  if (["false", "no", "0"].includes(t)) return false;
  return v;
}

export function createCrmAdapters(
  admin: AdminClient,
  overrides: Partial<CrmServices> = {},
): Required<CrmPort> {
  const s: CrmServices = { ...defaultServices(), ...overrides };
  const ctxFor = (run: RunRecord) => ({ admin, orgId: run.org_id, userId: null });

  async function defaultPipeline(orgId: string): Promise<string | null> {
    const { data } = await admin
      .from("pipelines")
      .select("id, is_default")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .order("is_default", { ascending: false })
      .order("sort")
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }

  /** The person who published this flow version, with their current role permissions. */
  async function publisherMember(run: RunRecord): Promise<MemberLike> {
    const { data: ver } = await admin
      .from("flow_versions")
      .select("published_by")
      .eq("flow_id", run.flow_id)
      .eq("version", run.flow_version)
      .eq("org_id", run.org_id)
      .maybeSingle();
    const userId = ver?.published_by;
    if (!userId) throw new Error("Portal record: nobody is recorded as publishing this flow");
    const { data: m } = await admin
      .from("memberships")
      .select("user_id, role_id, status, roles(name, permissions)")
      .eq("org_id", run.org_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!m || m.status !== "active")
      throw new Error(
        "Portal record: the person who published this flow is no longer active; publish it again",
      );
    const role = m.roles as { name?: string; permissions?: unknown } | null;
    return {
      userId: m.user_id,
      orgId: run.org_id,
      roleId: m.role_id,
      roleName: role?.name,
      status: "active",
      permissions: Array.isArray(role?.permissions)
        ? (role.permissions as unknown[]).filter((p): p is string => typeof p === "string")
        : [],
    };
  }

  return {
    async createEnquiry(run, input) {
      const pipelineId = str(input.pipeline_id) ?? (await defaultPipeline(run.org_id));
      if (!pipelineId) throw new Error("No enquiry pipeline is set up in this workspace");
      const stageId = str(input.stage_id);
      if (input.if_open !== "create" && run.contact_id) {
        const { data: open } = await admin
          .from("enquiries")
          .select("id")
          .eq("org_id", run.org_id)
          .eq("contact_id", run.contact_id)
          .eq("pipeline_id", pipelineId)
          .eq("status", "open")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (open) {
          if (stageId) await s.moveStage(ctxFor(run), open.id, stageId);
          return { id: open.id, created: false };
        }
      }
      let channelId: string | null = null;
      if (run.conversation_id) {
        const { data: conv } = await admin
          .from("conversations")
          .select("channel_id")
          .eq("id", run.conversation_id)
          .eq("org_id", run.org_id)
          .maybeSingle();
        channelId = conv?.channel_id ?? null;
      }
      const created = await s.createEnquiry(ctxFor(run), {
        title: String(input.title),
        pipelineId,
        stageId,
        contactId: run.contact_id,
        channelId,
        source: str(input.source),
      });
      return { id: created.id, created: true };
    },

    async updateEnquiry(run, input) {
      const id = str(input.enquiry_id);
      if (!id) throw new Error("No enquiry to update");
      const ctx = ctxFor(run);
      switch (input.action) {
        case "stage":
          await s.moveStage(ctx, id, String(input.stage_id));
          break;
        case "pipeline":
          await s.movePipeline(ctx, id, String(input.pipeline_id), str(input.stage_id));
          break;
        case "status":
          await s.setStatus(ctx, id, input.status as EnquiryStatus, str(input.lost_reason));
          break;
        case "field": {
          const field = String(input.field);
          const value = typeof input.value === "string" ? input.value : "";
          if (field === "title") {
            if (!value.trim()) throw new Error("The enquiry title cannot be empty");
            await s.updateEnquiry(ctx, id, { title: value.trim().slice(0, 200) });
          } else if (field === "source") {
            await s.updateEnquiry(ctx, id, { source: value.trim() || null });
          } else if (field === "est_value") {
            const n = value.trim() === "" ? null : Number(value.replace(/[\s,]/g, ""));
            if (n !== null && !Number.isFinite(n))
              throw new Error("The estimated value is not a number");
            await s.updateEnquiry(ctx, id, { estValue: n });
          } else if (field === "appt_date") {
            const t = value.trim() === "" ? null : Date.parse(value);
            if (t !== null && !Number.isFinite(t))
              throw new Error("The appointment date is not a date");
            await s.updateEnquiry(ctx, id, {
              apptDate: t === null ? null : new Date(t).toISOString(),
            });
          } else if (field.startsWith("custom.")) {
            const key = field.slice("custom.".length);
            const { data: current } = await admin
              .from("enquiries")
              .select("custom")
              .eq("org_id", run.org_id)
              .eq("id", id)
              .is("deleted_at", null)
              .maybeSingle();
            if (!current) throw new Error("Enquiry not found");
            const defs = await s.loadEnquiryCustomFields(admin, run.org_id);
            if (!defs.some((d) => d.key === key))
              throw new Error(`There is no enquiry field "${key.slice(0, 40)}"`);
            const merged = mergeEnquiryCustom(
              defs,
              (current.custom ?? {}) as Record<string, unknown>,
              { [key]: value === "" ? null : value },
            );
            if (!merged.ok) throw new Error(merged.error);
            await s.updateEnquiry(ctx, id, { custom: merged.value });
          } else {
            throw new Error("That enquiry field cannot be set by a flow");
          }
          break;
        }
        default:
          throw new Error("Unknown enquiry change");
      }
      return { id, created: false };
    },

    async addTask(run, input) {
      const res = await s.createTask(ctxFor(run), {
        type: input.type as TaskType,
        subject: String(input.subject),
        notes: str(input.notes),
        dueAt: String(input.due_at),
        assigneeId: str(input.assignee_id),
        contactId: run.contact_id,
        enquiryId: str(input.enquiry_id),
      });
      return { id: res.id, created: true };
    },

    async upsertPortalRecord(run, input) {
      const def = getPortalObject(String(input.object));
      if (!def) throw new Error("That portal object does not exist");
      const member = await publisherMember(run);
      const raw = (input.values ?? {}) as Record<string, string>;
      const values: Record<string, unknown> = {};
      for (const col of def.columns) {
        if (!(col.key in raw)) continue;
        const v = raw[col.key] ?? "";
        values[col.key] =
          col.type === "boolean"
            ? boolish(v)
            : col.type === "multi_select"
              ? v
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
              : v;
      }
      const res =
        input.mode === "update"
          ? await s.updateRecord(admin, member, def.key, String(input.record_id ?? ""), values)
          : await s.createRecord(admin, member, def.key, values);
      if (!res.ok) {
        const first = res.fieldErrors ? Object.values(res.fieldErrors)[0] : undefined;
        throw new Error(first ?? res.error);
      }
      return { id: String(res.data.id), created: input.mode !== "update" };
    },

    async bookAppointment(run, input) {
      if (!run.contact_id) throw new Error("This step needs a contact");
      const res = await s.createAppointment(admin, {
        orgId: run.org_id,
        actorId: null,
        contactId: run.contact_id,
        locationId: String(input.location_id),
        specialistId: String(input.specialist_id),
        serviceId: String(input.service_id),
        startsAt: new Date(String(input.starts_at)),
        notify: input.notify === true,
        source: "bot",
      });
      if (!res.ok) throw new Error(res.error);
      return { id: res.appointment.id, created: true };
    },

    async setConversationLabel(run, input) {
      if (!run.conversation_id) throw new Error("This step needs a conversation");
      const { data: tag } = await admin
        .from("tags")
        .select("id, scope")
        .eq("id", input.tag_id)
        .eq("org_id", run.org_id)
        .maybeSingle();
      if (!tag || tag.scope !== "conversation")
        throw new Error("That conversation label does not exist");
      if (input.on) {
        const { data, error } = await admin
          .from("conversation_labels")
          .upsert(
            { org_id: run.org_id, conversation_id: run.conversation_id, tag_id: tag.id },
            { onConflict: "conversation_id,tag_id", ignoreDuplicates: true },
          )
          .select("tag_id");
        if (error) throw new Error("Could not add the label");
        return { changed: (data?.length ?? 0) > 0 };
      }
      const { data, error } = await admin
        .from("conversation_labels")
        .delete()
        .eq("org_id", run.org_id)
        .eq("conversation_id", run.conversation_id)
        .eq("tag_id", tag.id)
        .select("tag_id");
      if (error) throw new Error("Could not remove the label");
      return { changed: (data?.length ?? 0) > 0 };
    },

    async createPaymentLink(run, input, opts) {
      if (!run.contact_id) return { ok: false, error: "This step needs a contact" };
      // createPaymentRequest checks: switched on, not a training workspace, credentials, approved UTILITY template, invoice,
      // amount within the total, one live request per invoice, guardian-aware recipient; it sends through queueOutbound.
      const res = await s.createPaymentRequest(admin, {
        orgId: run.org_id,
        actorId: null,
        expectContactId: run.contact_id,
        invoiceNumber: input.invoice_number,
        amount: input.amount,
        flowStepKey: opts.stepKey,
      });
      return res.ok ? { ok: true, requestId: res.requestId } : { ok: false, error: res.error };
    },

    async sendMetaEvent(run, input) {
      if (!run.contact_id) return { status: "skipped:no_contact" };
      const { data: attribution } = await admin
        .from("ad_attributions")
        .select("id")
        .eq("org_id", run.org_id)
        .eq("contact_id", run.contact_id)
        .order("clicked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!attribution) return { status: "no_ad_click" };
      // The event id is a hash of (org, event, subject). Using the same subject as the automatic events (the ad click for
      // Contact, the enquiry for Lead, the appointment for Schedule) makes a flow event and the sweep's the SAME event.
      const vars = run.context.vars;
      const trig = run.context.trigger;
      const subject =
        input.event_name === "Lead"
          ? (str(vars.enquiry_id) ?? run.enquiry_id ?? attribution.id)
          : input.event_name === "Schedule"
            ? (str(vars.appointment_id) ?? str(trig.appointment_id) ?? attribution.id)
            : attribution.id;
      const status = await s.queueCapiEvent(admin, {
        orgId: run.org_id,
        attributionId: attribution.id,
        eventName: input.event_name as "Contact" | "Lead" | "Schedule",
        subjectId: subject,
        eventTime: new Date(),
      });
      return { status };
    },

    async lastInbound(run) {
      if (!run.conversation_id) return null;
      const { data } = await admin
        .from("messages")
        .select("id, body")
        .eq("org_id", run.org_id)
        .eq("conversation_id", run.conversation_id)
        .eq("direction", "in")
        .not("kind", "in", "(reaction,system)")
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? { messageId: data.id, body: data.body } : null;
    },

    async intentsFor(run, messageId) {
      const read = async () => {
        const { data } = await admin
          .from("ai_message_intents")
          .select("intents")
          .eq("org_id", run.org_id)
          .eq("message_id", messageId)
          .eq("source", "model")
          .maybeSingle();
        return data ? (data.intents as string[]) : null;
      };
      const { data: org } = await admin
        .from("orgs")
        .select("settings")
        .eq("id", run.org_id)
        .maybeSingle();
      const ai = readAiSettings(org?.settings);
      const copilot = readCopilotSettings(org?.settings);
      // Like AI tags starting flows: a label may choose the patient's path only with the clinical lead's signed
      // setting for that label. Emergency is always kept (it stops the run, never routes).
      const signed = (labels: string[] | null) =>
        labels && labels.filter((l) => l === "emergency" || tagMayStartFlows(ai, copilot, l));
      const existing = await read();
      if (existing) return signed(existing);
      if (!ai.enabled || !copilot.intent_detection) return null;
      // The existing pipeline: wording check, master switch, daily cap, provider, usage row, closed-enum parse, labels only.
      await s.processIntentJob(admin, messageId);
      return signed(await read());
    },
  };
}
