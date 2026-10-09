import "server-only";

import { changeAppointmentStatus, createAppointment } from "@/lib/appointments/service";
import type { MemberLike } from "@/lib/auth/can";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import {
  createEnquiry,
  EnquiryError,
  moveStage,
  setStatus,
  updateEnquiry,
} from "@/lib/enquiries/service";
import { emit } from "@/lib/events/emit";
import { FlowNodeError, type FlowPorts } from "@/lib/flow-engine/ports";
import type { RunRow } from "@/lib/flow-engine/scope";
import { queueOutbound, type SendSpec } from "@/lib/inbox/send";
import { safeRequest } from "@/lib/net/safe-request";
import { UnsafeUrlError } from "@/lib/net/url-guard";
import { createNotification, notifyMembersWithPermission } from "@/lib/notifications";
import { createRecord, updateRecord } from "@/lib/portal/service";
import { requirePortalObject } from "@/lib/portal/objects";
import { classifyRecipient, isMarketingCategory } from "@/lib/campaigns/recipients";
import { redactText } from "@/lib/redact";
import { createTask } from "@/lib/tasks/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/lib/supabase/types";
import { previewFor } from "@/lib/whatsapp/parse";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type PortContext = {
  admin: AdminClient;
  run: RunRow;
  /** The person accountable for the flow (publisher); audit rows and CRM writes are attributed to them. */
  ownerId: string | null;
  timezone: string;
  /** The step being executed (1-based); used to avoid sending twice when a step is retried. */
  seq: number;
  /** Conversation-driven runs ride the priority lane so replies are quick. */
  live: boolean;
};

const CONTACT_FIELDS = new Set([
  "first_name",
  "last_name",
  "email",
  "gender",
  "language",
  "label",
  "nationality",
]);
const GENDERS = new Set(["female", "male", "other", "unknown"]);

export function createDbPorts(c: PortContext): FlowPorts {
  const { admin, run } = c;
  const orgId = run.org_id;

  const needConversation = () => {
    if (!run.conversation_id)
      throw new FlowNodeError("This step needs a conversation, and this run has none.");
    return run.conversation_id;
  };
  const needContact = () => {
    if (!run.contact_id)
      throw new FlowNodeError("This step needs a patient, and this run has none.");
    return run.contact_id;
  };

  async function sendOnce(spec: SendSpec, body: string) {
    const conversationId = needConversation();
    const key = String(c.seq);
    const { data: existing } = await admin
      .from("messages")
      .select("id")
      .eq("flow_run_id", run.id)
      .eq("payload->>flow_step", key)
      .limit(1);
    if (existing?.length) return; // a retry of a step that already queued its message
    await queueOutbound(admin, {
      orgId,
      conversationId,
      spec,
      body,
      sentByUserId: null,
      flowRunId: run.id,
      extraPayload: { flow_step: key },
      priority: c.live,
    });
  }

  async function ownerMember(permission: string): Promise<MemberLike> {
    if (!c.ownerId)
      throw new FlowNodeError("This flow has no responsible person; publish it again.");
    return {
      userId: c.ownerId,
      orgId,
      roleId: "flow",
      status: "active",
      permissions: [permission],
    };
  }

  const enquiryCtx = { admin, orgId, userId: c.ownerId };

  return {
    now: () => new Date(),
    timezone: c.timezone,
    hasConversation: !!run.conversation_id,

    sendText: (text) => sendOnce({ type: "text", body: text }, text),

    sendButtons: (text, options) =>
      sendOnce(
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text },
            action: {
              buttons: options.map((o) => ({
                type: "reply" as const,
                reply: { id: o.id, title: o.title },
              })),
            },
          },
        },
        text,
      ),

    sendList: (text, buttonLabel, options) =>
      sendOnce(
        {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text },
            action: {
              button: buttonLabel,
              sections: [{ rows: options.map((o) => ({ id: o.id, title: o.title })) }],
            },
          },
        },
        text,
      ),

    async sendTemplate(templateId, values) {
      const conversationId = needConversation();
      const contactId = needContact();
      const [{ data: tpl }, { data: contact }, { data: conversation }] = await Promise.all([
        admin
          .from("wa_templates")
          .select("id, name, status, category, components, waba_id")
          .eq("id", templateId)
          .eq("org_id", orgId)
          .maybeSingle(),
        admin
          .from("contacts")
          .select("phone_e164, wa_bsuid, promotions_opt_in, stop_marketing, deleted_at")
          .eq("id", contactId)
          .eq("org_id", orgId)
          .maybeSingle(),
        admin
          .from("conversations")
          .select("channel_id, channels(waba_id)")
          .eq("id", conversationId)
          .eq("org_id", orgId)
          .maybeSingle(),
      ]);
      if (!tpl) throw new FlowNodeError("The template no longer exists.");
      if (tpl.status !== "APPROVED")
        throw new FlowNodeError(`Template "${tpl.name}" is ${tpl.status}, not approved.`);
      const skip = classifyRecipient(contact, { marketing: isMarketingCategory(tpl.category) });
      if (skip)
        throw new FlowNodeError(
          `The patient cannot receive this template (${skip.replaceAll("_", " ")}).`,
        );
      const wabaId = (conversation?.channels as { waba_id?: string } | null)?.waba_id;
      if (wabaId && tpl.waba_id && wabaId !== tpl.waba_id)
        throw new FlowNodeError(
          "This template belongs to a different WhatsApp account than the conversation's number.",
        );
      const preview = renderTemplatePreview(
        tpl.components as unknown as MetaTemplateComponent[],
        values,
      );
      if (preview.missing.length)
        throw new FlowNodeError(
          `Template variables are not filled in: ${preview.missing.join(", ")}`,
        );
      await sendOnce(
        { type: "template", template_id: tpl.id, values },
        [preview.headerText, preview.body].filter(Boolean).join("\n"),
      );
    },

    async assign(target) {
      const conversationId = needConversation();
      if (target.userId) {
        const { data } = await admin
          .from("memberships")
          .select("user_id")
          .eq("org_id", orgId)
          .eq("user_id", target.userId)
          .eq("status", "active")
          .maybeSingle();
        if (!data) throw new FlowNodeError("The person to assign to is not an active member.");
      }
      if (target.teamId) {
        const { data } = await admin
          .from("teams")
          .select("id")
          .eq("org_id", orgId)
          .eq("id", target.teamId)
          .maybeSingle();
        if (!data) throw new FlowNodeError("The team to assign to no longer exists.");
      }
      const { error } = await admin
        .from("conversations")
        .update({
          assignee_user_id: target.userId ?? null,
          assignee_team_id: target.teamId ?? null,
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);
      if (error) throw new Error(`assign: ${error.code}`);
      await emit(orgId, "conversation.assigned", {
        conversation_id: conversationId,
        assignee_user_id: target.userId ?? null,
        by_flow_run: run.id,
      });
    },

    async closeConversation() {
      const conversationId = needConversation();
      const { error } = await admin
        .from("conversations")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
          closed_by: null,
          bot_active: false,
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);
      if (error) throw new Error(`close: ${error.code}`);
      await emit(orgId, "conversation.closed", {
        conversation_id: conversationId,
        by_flow_run: run.id,
      });
    },

    async addComment(text) {
      const conversationId = needConversation();
      const key = String(c.seq);
      const { data: existing } = await admin
        .from("messages")
        .select("id")
        .eq("flow_run_id", run.id)
        .eq("payload->>flow_step", key)
        .limit(1);
      if (existing?.length) return;
      const at = new Date().toISOString();
      const { error } = await admin.from("messages").insert({
        org_id: orgId,
        conversation_id: conversationId,
        direction: "note",
        kind: "note",
        body: text,
        status: "received",
        sent_by_user_id: null,
        flow_run_id: run.id,
        payload: { flow_step: key },
        at,
      });
      if (error) throw new Error(`comment: ${error.code}`);
      await admin
        .from("conversations")
        .update({
          last_message_at: at,
          last_message_preview: previewFor("note", text),
          last_message_direction: "note",
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);
    },

    async updateContact(patch) {
      const contactId = needContact();
      const update: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!CONTACT_FIELDS.has(k)) throw new FlowNodeError(`"${k}" cannot be changed by a flow.`);
        const value = v.trim();
        if (k === "gender") {
          const g = value.toLowerCase();
          if (g && !GENDERS.has(g))
            throw new FlowNodeError("Gender must be female, male, other or unknown.");
          update[k] = g || null;
        } else if (k === "email") {
          if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            throw new FlowNodeError("The e-mail address is not valid.");
          update[k] = value || null;
        } else if (k === "first_name" || k === "last_name") {
          update[k] = value;
        } else update[k] = value || null;
      }
      const { error } = await admin
        .from("contacts")
        .update(update as TablesUpdate<"contacts">)
        .eq("id", contactId)
        .eq("org_id", orgId);
      if (error) throw new FlowNodeError("The contact could not be updated.");
      await addTimelineEvent(admin, {
        orgId,
        contactId,
        type: "contact.updated",
        actorType: "system",
        payload: { fields: Object.keys(update), flow_run_id: run.id },
      });
    },

    async upsertEnquiry(input) {
      try {
        const ctx = (run.context ?? {}) as Record<string, unknown>;
        if (input.action === "create") {
          let pipelineId = input.pipelineId;
          if (!pipelineId) {
            const { data } = await admin
              .from("pipelines")
              .select("id")
              .eq("org_id", orgId)
              .is("archived_at", null)
              .order("is_default", { ascending: false })
              .order("sort")
              .limit(1)
              .maybeSingle();
            pipelineId = data?.id;
          }
          if (!pipelineId)
            throw new FlowNodeError("There is no pipeline to create the enquiry in.");
          let channelId: string | null = null;
          if (run.conversation_id) {
            const { data } = await admin
              .from("conversations")
              .select("channel_id")
              .eq("id", run.conversation_id)
              .maybeSingle();
            channelId = data?.channel_id ?? null;
          }
          const created = await createEnquiry(enquiryCtx, {
            title: (input.subject?.trim() || "New enquiry").slice(0, 200),
            pipelineId,
            stageId: input.stageId ?? null,
            contactId: run.contact_id,
            channelId,
            source: "flow",
          });
          return { id: created.id };
        }
        const id = typeof ctx.enquiry_id === "string" ? ctx.enquiry_id : null;
        if (!id)
          throw new FlowNodeError(
            "There is no enquiry to update; add a Create enquiry step first or use an enquiry trigger.",
          );
        if (input.stageId) await moveStage(enquiryCtx, id, input.stageId);
        if (input.status && input.status !== "open")
          await setStatus(enquiryCtx, id, input.status, input.lostReason ?? "Closed by automation");
        if (input.subject)
          await updateEnquiry(enquiryCtx, id, { title: input.subject.slice(0, 200) });
        return { id };
      } catch (e) {
        if (e instanceof EnquiryError) throw new FlowNodeError(e.message);
        throw e;
      }
    },

    async createTask(input) {
      const t = await createTask(
        { admin, orgId, userId: c.ownerId },
        {
          type: "follow_up",
          subject: input.subject.slice(0, 200),
          notes: input.notes ?? null,
          dueAt: input.dueAt.toISOString(),
          assigneeId: input.assigneeId ?? null,
          contactId: run.contact_id,
          enquiryId:
            typeof (run.context as Record<string, unknown>)?.enquiry_id === "string"
              ? ((run.context as Record<string, unknown>).enquiry_id as string)
              : null,
        },
      ).catch((e: unknown) => {
        throw new FlowNodeError(
          e instanceof Error && e.message.length < 200
            ? e.message
            : "The task could not be created.",
        );
      });
      return { id: t.id };
    },

    async portalRecord(input) {
      let def;
      try {
        def = requirePortalObject(input.objectKey);
      } catch {
        throw new FlowNodeError(`Unknown portal object "${input.objectKey}".`);
      }
      if (!def.writePerm) throw new FlowNodeError(`${def.label} is read-only.`);
      // The flow can write exactly what its publisher was allowed to write (checked again at publish).
      const member = await ownerMember(def.writePerm);
      const res =
        input.action === "create"
          ? await createRecord(admin, member, input.objectKey, input.values)
          : await updateRecord(admin, member, input.objectKey, input.recordId ?? "", input.values);
      if (!res.ok) throw new FlowNodeError(res.error);
      return { id: String((res.data as { id?: unknown }).id ?? "") };
    },

    async appointment(input) {
      if (input.action === "set_status") {
        const ctx = (run.context ?? {}) as Record<string, unknown>;
        const id =
          input.appointmentId ||
          (typeof ctx.appointment_id === "string" ? ctx.appointment_id : null);
        if (!id) throw new FlowNodeError("There is no appointment to change.");
        const res = await changeAppointmentStatus(admin, {
          orgId,
          appointmentId: id,
          to: input.status,
          actorId: c.ownerId,
          actorType: "system",
          via: "portal",
        });
        if (!res.ok) throw new FlowNodeError(res.error);
        return { id };
      }
      const contactId = needContact();
      if (!input.specialistId || !input.locationId || !input.serviceId)
        throw new FlowNodeError("Booking needs a doctor, a location and a service.");
      const res = await createAppointment(admin, {
        orgId,
        actorId: c.ownerId,
        contactId,
        locationId: input.locationId,
        specialistId: input.specialistId,
        serviceId: input.serviceId,
        startsAt: input.startsAt,
        source: "bot",
      });
      if (!res.ok) throw new FlowNodeError(res.error);
      return { id: res.appointment.id };
    },

    async httpRequest(input) {
      try {
        const res = await safeRequest(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          timeoutMs: 8000,
          deadlineMs: 15000,
          maxBytes: 200_000,
          onOverflow: "truncate",
          maxRedirects: 0,
        });
        return { status: res.status, text: res.body.toString("utf8") };
      } catch (e) {
        if (e instanceof UnsafeUrlError)
          throw new FlowNodeError("That address is not allowed (HTTPS to a public host only).");
        console.error("[flows] api_action failed", {
          message: redactText(e instanceof Error ? e.message : String(e), 120),
        });
        throw new FlowNodeError("The request could not be completed.");
      }
    },

    async notify(input) {
      if (input.userId) {
        const { data } = await admin
          .from("memberships")
          .select("user_id")
          .eq("org_id", orgId)
          .eq("user_id", input.userId)
          .eq("status", "active")
          .maybeSingle();
        if (!data) return 0;
        await createNotification(admin, {
          orgId,
          userId: input.userId,
          type: "flow",
          title: input.title.slice(0, 120),
          body: input.body ?? null,
          payload: { flow_run_id: run.id },
        });
        return 1;
      }
      if (input.permission)
        return notifyMembersWithPermission(admin, orgId, input.permission, {
          type: "flow",
          title: input.title.slice(0, 120),
          body: input.body ?? null,
          payload: { flow_run_id: run.id },
        });
      return 0;
    },
  };
}
