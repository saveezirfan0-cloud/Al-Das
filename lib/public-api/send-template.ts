import "server-only";

import { z } from "zod";

import { emit } from "@/lib/events/emit";
import { routeNewConversation } from "@/lib/inbox/inbound";
import { queueOutbound } from "@/lib/inbox/send";
import { readInboxSettings } from "@/lib/inbox/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import { toE164 } from "@/lib/whatsapp/phone";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * POST /api/public/v1/send-template. Same rules as sending a template from the inbox:
 *   - only APPROVED templates
 *   - marketing templates never go to a contact with stop_marketing (CLAUDE.md rule 11)
 *   - every variable must be supplied
 *   - the message is only QUEUED (rule 4): the outbound handler applies the per-number rate limit
 *     and Meta delivery; this call returns 202 with the queued message id
 */

export const sendTemplateSchema = z
  .object({
    to: z.string().trim().min(1).max(32),
    template: z.string().trim().min(1).max(512),
    language: z.string().trim().min(2).max(16),
    /** Keys are the template's variable keys, e.g. { "body.1": "Amal", "body.2": "Tuesday 10:00" }. */
    variables: z.record(z.string().max(64), z.string().max(1024)).default({}),
    channel_id: z.string().uuid().optional(),
    contact: z.object({ first_name: z.string().trim().max(100).optional(), last_name: z.string().trim().max(100).optional() }).strict().optional(),
  })
  .strict();
export type SendTemplateInput = z.infer<typeof sendTemplateSchema>;

export type SendTemplateResult =
  | { ok: true; data: { message_id: string; conversation_id: string; contact_id: string; status: "queued" } }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

const fail = (status: number, code: string, message: string, details?: unknown): SendTemplateResult => ({ ok: false, status, code, message, details });

export async function sendTemplateViaApi(admin: AdminClient, orgId: string, input: SendTemplateInput): Promise<SendTemplateResult> {
  const phone = toE164(input.to);
  if (!phone) return fail(422, "invalid_phone", "That phone number is not valid. Use international format, e.g. +971501234567.");

  // 1. Which WhatsApp number sends it
  const { data: channels } = await admin.from("channels").select("id, waba_id, status").eq("org_id", orgId).eq("status", "active");
  let channel = (channels ?? [])[0];
  if (input.channel_id) {
    channel = (channels ?? []).find((c) => c.id === input.channel_id) as typeof channel;
    if (!channel) return fail(422, "channel_not_found", "That channel_id is not an active WhatsApp number in this workspace.");
  } else if ((channels ?? []).length === 0) {
    return fail(422, "no_active_channel", "This workspace has no active WhatsApp number.");
  } else if ((channels ?? []).length > 1) {
    return fail(422, "channel_required", "This workspace has several WhatsApp numbers: pass channel_id.", { channel_ids: (channels ?? []).map((c) => c.id) });
  }

  // 2. The template (per WABA, so the same name on another number is not confused)
  const { data: tpl } = await admin
    .from("wa_templates")
    .select("id, name, status, category, components")
    .eq("org_id", orgId)
    .eq("waba_id", channel.waba_id)
    .eq("name", input.template)
    .eq("language", input.language)
    .is("archived_at", null)
    .maybeSingle();
  if (!tpl) return fail(404, "template_not_found", `No template '${input.template}' in language '${input.language}' on that number.`);
  if (tpl.status !== "APPROVED") return fail(422, "template_not_approved", `Template '${tpl.name}' is ${tpl.status}; only approved templates can be sent.`);

  const components = tpl.components as unknown as MetaTemplateComponent[];
  const preview = renderTemplatePreview(components, input.variables);
  // Checked first: a media header shows up as a "missing" header.media variable, which would be a confusing error.
  if (preview.headerMedia) return fail(422, "unsupported_template", "Templates with a media or location header cannot be sent through the API yet.");
  if (preview.missing.length) return fail(422, "missing_variables", "Some template variables have no value.", { missing: preview.missing });

  // 3. The patient: reuse the contact that owns this phone, or create one
  let { data: contact } = await admin.from("contacts").select("id, stop_marketing").eq("org_id", orgId).eq("phone_e164", phone).is("deleted_at", null).maybeSingle();
  if (!contact) {
    const { data: created, error } = await admin
      .from("contacts")
      .insert({ org_id: orgId, phone_e164: phone, first_name: input.contact?.first_name ?? "", last_name: input.contact?.last_name ?? "", source: "api" })
      .select("id, stop_marketing")
      .single();
    if (error) {
      // A concurrent request may have just created it.
      const { data: again } = await admin.from("contacts").select("id, stop_marketing").eq("org_id", orgId).eq("phone_e164", phone).is("deleted_at", null).maybeSingle();
      if (!again) return fail(500, "internal_error", "Could not create the contact.");
      contact = again;
    } else {
      contact = created;
      await emit(orgId, "contact.created", { contact_id: created.id, source: "api" });
    }
  }
  if (tpl.category === "MARKETING" && contact.stop_marketing) {
    return fail(422, "recipient_opted_out", "This patient has opted out of marketing messages.");
  }

  // 4. The conversation (reuse the live one on this number, else open and route a new one)
  let conversationId: string;
  const { data: live } = await admin.from("conversations").select("id").eq("channel_id", channel.id).eq("contact_id", contact.id).neq("status", "closed").maybeSingle();
  if (live) {
    conversationId = live.id;
  } else {
    const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).single();
    const route = await routeNewConversation(admin, orgId, readInboxSettings(org?.settings));
    const { data: conv, error } = await admin
      .from("conversations")
      .insert({ org_id: orgId, channel_id: channel.id, contact_id: contact.id, status: "open", assignee_team_id: route.teamId, assignee_user_id: route.userId })
      .select("id")
      .single();
    if (error || !conv) return fail(500, "internal_error", "Could not open the conversation.");
    conversationId = conv.id;
    await emit(orgId, "conversation.opened", { conversation_id: conv.id, contact_id: contact.id, channel_id: channel.id, via: "api" });
  }

  // 5. Queue it. API sends are automations: they take the standard lane, not the live-chat priority one.
  const message = await queueOutbound(admin, {
    orgId,
    conversationId,
    spec: { type: "template", template_id: tpl.id, values: input.variables },
    body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
    sentByUserId: null,
    priority: false,
  });
  return { ok: true, data: { message_id: message.id, conversation_id: conversationId, contact_id: contact.id, status: "queued" } };
}
