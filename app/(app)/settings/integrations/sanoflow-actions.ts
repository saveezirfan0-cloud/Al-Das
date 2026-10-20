"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { SANOFLOW_WABA_ID } from "@/lib/integrations/sanoflow/config";
import {
  sanoflowChannelRef,
  sanoflowTemplateDraft,
  sanoflowTemplateNumberProblem,
} from "@/lib/integrations/sanoflow/setup";
import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const numberSchema = z.object({
  name: z.string().trim().min(1).max(80),
  displayPhone: z.string().trim().max(32),
  sendRatePerSec: z.number().int().min(1).max(20),
});

/**
 * Adds a WhatsApp number that sends through Sanoflow (OQ-182). It has no Meta ids (waba_id 'sanoflow', a random reference), so
 * no Meta call can ever be pointed at it; the number itself is the clinic's business number, shown to staff only.
 */
export async function addSanoflowNumber(
  input: z.input<typeof numberSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = numberSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the name, number and speed." };
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("channels")
    .insert({
      org_id: member.orgId,
      type: "whatsapp",
      transport: "sanoflow",
      name: p.data.name,
      waba_id: SANOFLOW_WABA_ID,
      phone_number_id: sanoflowChannelRef(randomUUID()),
      display_phone: p.data.displayPhone || null,
      send_rate_per_sec: p.data.sendRatePerSec,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not add the number." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "channel.sanoflow_added",
    entity: "channel",
    entityId: data.id,
    diff: { fields: ["name", "display_phone", "send_rate_per_sec"] },
  });
  revalidatePath("/settings/integrations", "layout");
  revalidatePath("/settings/channels");
  return { ok: true, message: "Sanoflow number added." };
}

const linkSchema = z.object({
  templateId: z.string().uuid(),
  sanoflowTemplateId: z.number().int().nullable(),
});

/** Sets (or clears) the Sanoflow template number of a Pulse template. Without one, the template is never sent through Sanoflow. */
export async function setSanoflowTemplateNumber(
  input: z.input<typeof linkSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const p = linkSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  if (p.data.sanoflowTemplateId !== null) {
    const problem = sanoflowTemplateNumberProblem(p.data.sanoflowTemplateId);
    if (problem) return { ok: false, error: problem };
  }
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("wa_templates")
    .update({ sanoflow_template_id: p.data.sanoflowTemplateId })
    .eq("id", p.data.templateId)
    .eq("org_id", member.orgId)
    .select("id");
  if (error) return { ok: false, error: "Could not save the number." };
  if (!data?.length) return { ok: false, error: "Template not found." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.sanoflow_linked",
    entity: "wa_template",
    entityId: p.data.templateId,
    diff: { sanoflow_template_id: p.data.sanoflowTemplateId },
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: p.data.sanoflowTemplateId ? "Linked." : "Link removed." };
}

const templateSchema = z.object({
  channelId: z.string().uuid(),
  name: z.string().max(512),
  language: z.string().max(10),
  category: z.string().max(20),
  body: z.string().max(1100),
  sanoflowTemplateId: z.number().int(),
  approvedInSanoflow: z.literal(true),
});

/**
 * Copies a template that is already approved in Sanoflow into Pulse, so Pulse's automations can use it (status APPROVED because
 * Sanoflow approved it; the person ticks that it is). Pulse never submits it to Meta or Sanoflow.
 */
export async function addSanoflowTemplate(
  input: z.input<typeof templateSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const p = templateSchema.safeParse(input);
  if (!p.success)
    return {
      ok: false,
      error: "Fill in every field and confirm the template is approved in Sanoflow.",
    };
  const d = sanoflowTemplateDraft(p.data);
  if (!d.ok) return { ok: false, error: d.error };
  const admin = createAdminClient(member.userId);
  const { data: channel } = await admin
    .from("channels")
    .select("id")
    .eq("id", p.data.channelId)
    .eq("org_id", member.orgId)
    .eq("transport", "sanoflow")
    .maybeSingle();
  if (!channel) return { ok: false, error: "Choose a Sanoflow number." };
  const { data, error } = await admin
    .from("wa_templates")
    .insert({
      org_id: member.orgId,
      channel_id: channel.id,
      waba_id: SANOFLOW_WABA_ID,
      name: d.draft.name,
      language: d.draft.language,
      category: d.draft.category,
      status: "APPROVED",
      components: d.draft.components as unknown as NonNullable<Json>,
      parameter_format: "positional",
      sanoflow_template_id: d.draft.sanoflowTemplateId,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error?.code === "23505")
    return { ok: false, error: "A Sanoflow template with this name and language already exists." };
  if (error || !data) return { ok: false, error: "Could not add the template." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.sanoflow_added",
    entity: "wa_template",
    entityId: data.id,
    diff: {
      sanoflow_template_id: d.draft.sanoflowTemplateId,
      category: d.draft.category,
      fields: ["name", "language", "body"],
    },
  });
  revalidatePath("/settings/integrations", "layout");
  revalidatePath("/templates");
  return {
    ok: true,
    message: "Template added. Map it in Recall, Appointments or a flow like any other.",
  };
}
