"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  buildComponents,
  draftSchema,
  slugifyName,
  storedType,
  validateDraft,
  type TemplateDraft,
} from "@/lib/templates/builder";
import { isTemplateSource } from "@/lib/templates/sources";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { syncTemplatesForChannel } from "@/lib/whatsapp/sync";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function metaError(err: unknown, fallback: string): string {
  if (err instanceof WhatsAppApiError) {
    const detail = err.userMessage ?? err.details;
    return `${err.mapped.message}${detail ? ` — ${detail}` : ""}`;
  }
  return err instanceof Error && err.message.length < 200 ? err.message : fallback;
}

type Admin = ReturnType<typeof createAdminClient>;

async function activeChannel(admin: Admin, orgId: string, channelId: string) {
  const { data } = await admin
    .from("channels")
    .select("id, org_id, phone_number_id, waba_id, status, name")
    .eq("org_id", orgId)
    .eq("id", channelId)
    .maybeSingle();
  if (!data) return { ok: false as const, error: "Choose a WhatsApp number." };
  if (data.status !== "active")
    return { ok: false as const, error: "That number is paused or disconnected." };
  return { ok: true as const, channel: data };
}

const saveSchema = z.object({
  id: uuid.optional(),
  channel_id: uuid,
  draft: draftSchema,
  gallery_key: z.string().max(120).optional(),
});
export type SaveTemplateInput = z.input<typeof saveSchema>;

function rowFields(draft: TemplateDraft) {
  return {
    name: draft.name,
    language: draft.language,
    category: draft.category,
    type: storedType(draft),
    components: buildComponents(draft) as unknown as NonNullable<Json>,
    variable_map: draft.variableMap as unknown as NonNullable<Json>,
    parameter_format: "positional",
  };
}

function uniqueMessage(error: { code?: string }): string | null {
  return error.code === "23505"
    ? "A template with that name and language already exists on this WhatsApp account."
    : null;
}

// ---------------------------------------------------------------------------
// Drafts and submission
// ---------------------------------------------------------------------------

/** Saves work in progress locally (nothing is sent to Meta). Only drafts can be overwritten. */
export async function saveTemplateDraft(
  input: z.input<typeof saveSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("templates.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid template");
  const { id, channel_id, draft, gallery_key } = parsed.data;
  if (!draft.name || !/^[a-z0-9_]+$/.test(draft.name))
    return fail("Give the template a name with lowercase letters, numbers and underscores.");
  const admin = createAdminClient();
  const ch = await activeChannel(admin, member.orgId, channel_id);
  if (!ch.ok) return fail(ch.error);

  if (id) {
    const { data, error } = await admin
      .from("wa_templates")
      .update({ ...rowFields(draft), channel_id, waba_id: ch.channel.waba_id })
      .eq("id", id)
      .eq("org_id", member.orgId)
      .eq("status", "DRAFT")
      .select("id")
      .maybeSingle();
    if (error) return fail(uniqueMessage(error) ?? "Could not save the draft.");
    if (!data) return fail("Only drafts can be saved; submit the template to change a live one.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "template.draft_saved",
      entity: "wa_template",
      entityId: id,
    });
    revalidatePath("/templates");
    return { ok: true, data: { id }, message: "Draft saved." };
  }

  const { data, error } = await admin
    .from("wa_templates")
    .insert({
      org_id: member.orgId,
      channel_id,
      waba_id: ch.channel.waba_id,
      ...rowFields(draft),
      status: "DRAFT",
      created_by: member.userId,
      gallery_key: gallery_key ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return fail(uniqueMessage(error ?? {}) ?? "Could not save the draft.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.draft_saved",
    entity: "wa_template",
    entityId: data.id,
  });
  revalidatePath("/templates");
  return { ok: true, data: { id: data.id }, message: "Draft saved." };
}

/**
 * Submits to Meta for review. A new or draft template is created; an existing one
 * (approved, rejected or paused) is edited in place, which sends it back to review.
 */
export async function submitTemplate(
  input: z.input<typeof saveSchema>,
): Promise<ActionResult<{ id: string; status: string }>> {
  const member = await requirePerm("templates.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid template");
  const { id, channel_id, draft, gallery_key } = parsed.data;
  const { errors } = validateDraft(draft);
  if (errors.length) return fail(errors[0].message);
  const admin = createAdminClient();
  const ch = await activeChannel(admin, member.orgId, channel_id);
  if (!ch.ok) return fail(ch.error);

  let existing: {
    id: string;
    status: string;
    meta_template_id: string | null;
    name: string;
    language: string;
    waba_id: string;
  } | null = null;
  if (id) {
    const { data } = await admin
      .from("wa_templates")
      .select("id, status, meta_template_id, name, language, waba_id")
      .eq("id", id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return fail("Template not found.");
    existing = data;
  }
  if (existing && existing.waba_id !== ch.channel.waba_id)
    return fail("A template can't move to a different WhatsApp account. Duplicate it instead.");

  const components = buildComponents(draft);
  const client = await clientForChannel(admin, ch.channel);
  const now = new Date().toISOString();

  try {
    if (existing?.meta_template_id) {
      if (existing.name !== draft.name || existing.language !== draft.language)
        return fail(
          "The name and language of a submitted template can't change. Duplicate it instead.",
        );
      if (!["APPROVED", "REJECTED", "PAUSED"].includes(existing.status))
        return fail(
          `A ${existing.status.toLowerCase().replace(/_/g, " ")} template can't be edited right now.`,
        );
      await client.updateTemplate(existing.meta_template_id, {
        components,
        ...(existing.status === "REJECTED" ? { category: draft.category } : {}),
      });
      await admin
        .from("wa_templates")
        .update({
          ...rowFields(draft),
          status: "PENDING",
          rejected_reason: null,
          submitted_at: now,
          channel_id,
        })
        .eq("id", existing.id)
        .eq("org_id", member.orgId);
      await recordAudit(admin, {
        orgId: member.orgId,
        userId: member.userId,
        action: "template.edited",
        entity: "wa_template",
        entityId: existing.id,
      });
      revalidatePath("/templates");
      return {
        ok: true,
        data: { id: existing.id, status: "PENDING" },
        message: "Changes sent to Meta for review.",
      };
    }

    const created = await client.createTemplate(
      {
        name: draft.name,
        language: draft.language,
        category: draft.category,
        parameter_format: "POSITIONAL",
        components,
        allow_category_change: true,
      },
      ch.channel.waba_id,
    );
    const fields = {
      ...rowFields(draft),
      category: created.category ?? draft.category,
      status: created.status ?? "PENDING",
      meta_template_id: created.id,
      submitted_at: now,
      rejected_reason: null,
      channel_id,
      waba_id: ch.channel.waba_id,
    };
    let rowId = existing?.id ?? null;
    if (rowId) {
      await admin.from("wa_templates").update(fields).eq("id", rowId).eq("org_id", member.orgId);
    } else {
      const ins = await admin
        .from("wa_templates")
        .insert({
          org_id: member.orgId,
          created_by: member.userId,
          gallery_key: gallery_key ?? null,
          ...fields,
        })
        .select("id")
        .single();
      if (ins.error || !ins.data) {
        // Meta accepted it; the nightly/manual sync will mirror it even if this insert failed.
        return fail(
          uniqueMessage(ins.error ?? {}) ??
            "Submitted to Meta, but saving it here failed. Run Sync templates.",
        );
      }
      rowId = ins.data.id;
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "template.submitted",
      entity: "wa_template",
      entityId: rowId,
      diff: { category: fields.category },
    });
    revalidatePath("/templates");
    const note =
      created.category && created.category !== draft.category
        ? ` Meta classed it as ${created.category}.`
        : "";
    return {
      ok: true,
      data: { id: rowId, status: fields.status },
      message: `Submitted to Meta for review.${note}`,
    };
  } catch (err) {
    return fail(metaError(err, "Meta rejected the request."));
  }
}

// ---------------------------------------------------------------------------
// List actions
// ---------------------------------------------------------------------------

async function ownedTemplate(orgId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("wa_templates")
    .select(
      "id, org_id, name, language, category, status, type, waba_id, channel_id, meta_template_id, components, variable_map, archived_at, channels(id, org_id, phone_number_id, waba_id)",
    )
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data ? { admin, template: data } : null;
}

export async function duplicateTemplate(id: string): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("templates.manage");
  const found = await ownedTemplate(member.orgId, id);
  if (!found) return fail("Template not found.");
  const { admin, template: t } = found;
  const base = `${t.name.replace(/_copy(_\d+)?$/, "")}_copy`;
  for (let n = 0; n < 20; n++) {
    const name = n === 0 ? base : `${base}_${n + 1}`;
    const { data, error } = await admin
      .from("wa_templates")
      .insert({
        org_id: member.orgId,
        channel_id: t.channel_id,
        waba_id: t.waba_id,
        name,
        language: t.language,
        category: t.category,
        type: t.type,
        components: t.components,
        variable_map: t.variable_map,
        status: "DRAFT",
        created_by: member.userId,
      })
      .select("id")
      .single();
    if (error?.code === "23505") continue;
    if (error || !data) return fail("Could not duplicate the template.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "template.duplicated",
      entity: "wa_template",
      entityId: data.id,
      diff: { from: id },
    });
    revalidatePath("/templates");
    return { ok: true, data: { id: data.id }, message: `Copied to the draft “${name}”.` };
  }
  return fail("Too many copies of this template already exist.");
}

/** Deletes on Meta (when it was ever submitted). A template campaigns still point at is archived instead. */
export async function deleteTemplate(id: string): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const found = await ownedTemplate(member.orgId, id);
  if (!found) return fail("Template not found.");
  const { admin, template: t } = found;

  if (t.meta_template_id && t.status !== "DELETED") {
    if (!t.channels)
      return fail("The WhatsApp number this template was synced from is gone; re-add it first.");
    try {
      const client = await clientForChannel(admin, t.channels);
      await client.deleteTemplate(t.name, { wabaId: t.waba_id, hsmId: t.meta_template_id });
    } catch (err) {
      return fail(metaError(err, "Meta could not delete the template."));
    }
  }
  const { count } = await admin
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("template_id", id);
  if ((count ?? 0) > 0) {
    await admin
      .from("wa_templates")
      .update({ archived_at: new Date().toISOString(), status: "DELETED" })
      .eq("id", id)
      .eq("org_id", member.orgId);
  } else {
    await admin.from("wa_templates").delete().eq("id", id).eq("org_id", member.orgId);
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.deleted",
    entity: "wa_template",
    entityId: id,
    diff: { name: t.name },
  });
  revalidatePath("/templates");
  return {
    ok: true,
    message:
      (count ?? 0) > 0
        ? "Deleted on Meta; kept as archived because campaigns use it."
        : "Template deleted.",
  };
}

/** Local hide/show: archived templates disappear from pickers and the default list. */
export async function archiveTemplate(id: string, archived: boolean): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const found = await ownedTemplate(member.orgId, id);
  if (!found) return fail("Template not found.");
  await found.admin
    .from("wa_templates")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: archived ? "template.archived" : "template.unarchived",
    entity: "wa_template",
    entityId: id,
  });
  revalidatePath("/templates");
  return { ok: true, message: archived ? "Template archived." : "Template restored." };
}

const mapSchema = z.record(z.string().max(60), z.string().max(300));

/** Which contact/appointment field fills each {{n}}. Used by the inbox picker, reminders and campaigns. */
export async function saveTemplateVariableMap(
  id: string,
  map: z.input<typeof mapSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const parsed = mapSchema.safeParse(map);
  if (!parsed.success) return fail("Invalid mapping.");
  const found = await ownedTemplate(member.orgId, id);
  if (!found) return fail("Template not found.");
  const keys = new Set(
    templateVariables(found.template.components as unknown as MetaTemplateComponent[]).map(
      (v) => v.key,
    ),
  );
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (!v) continue;
    if (!keys.has(k)) return fail(`This template has no variable “${k}”.`);
    if (!isTemplateSource(v)) return fail(`“${v}” is not a field a variable can be filled from.`);
    clean[k] = v;
  }
  await found.admin
    .from("wa_templates")
    .update({ variable_map: clean as unknown as NonNullable<Json> })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.variables_mapped",
    entity: "wa_template",
    entityId: id,
  });
  revalidatePath("/templates");
  return { ok: true, message: "Variable mapping saved." };
}

/** Pulls templates from Meta now (all accounts, or the one the number belongs to). */
export async function syncTemplatesAction(
  channelId?: string,
): Promise<ActionResult<{ synced: number }>> {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  let q = admin
    .from("channels")
    .select("id, org_id, phone_number_id, waba_id")
    .eq("org_id", member.orgId)
    .eq("status", "active");
  if (channelId) {
    if (!uuid.safeParse(channelId).success) return fail("Invalid number.");
    q = q.eq("id", channelId);
  }
  const { data: channels } = await q;
  if (!channels?.length) return fail("No active WhatsApp number to sync.");
  const seen = new Set<string>();
  let synced = 0;
  const problems: string[] = [];
  for (const channel of channels) {
    if (seen.has(channel.waba_id)) continue;
    seen.add(channel.waba_id);
    try {
      synced += (await syncTemplatesForChannel(admin, channel)).synced;
    } catch (err) {
      problems.push(metaError(err, "sync failed"));
    }
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.synced",
    entity: "wa_template",
    diff: { accounts: seen.size, synced },
  });
  revalidatePath("/templates");
  if (problems.length && synced === 0) return fail(problems[0]);
  return {
    ok: true,
    data: { synced },
    message: `${synced} templates synced${problems.length ? `; ${problems.length} account(s) failed` : ""}.`,
  };
}

// ---------------------------------------------------------------------------
// Header samples (Meta's resumable upload API)
// ---------------------------------------------------------------------------

const SAMPLE_TYPES: Record<string, "IMAGE" | "VIDEO" | "DOCUMENT"> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "video/mp4": "VIDEO",
  "application/pdf": "DOCUMENT",
};
const MAX_SAMPLE_BYTES = 16 * 1024 * 1024;

/** Uploads a header sample for the builder and returns Meta's handle. */
export async function uploadHeaderSample(
  formData: FormData,
): Promise<ActionResult<{ handle: string; name: string; format: "IMAGE" | "VIDEO" | "DOCUMENT" }>> {
  const member = await requirePerm("templates.manage");
  const file = formData.get("file");
  const channelId = String(formData.get("channel_id") ?? "");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a file.");
  if (!uuid.safeParse(channelId).success) return fail("Choose a WhatsApp number first.");
  const format = SAMPLE_TYPES[file.type];
  if (!format) return fail("Use a JPEG or PNG image, an MP4 video or a PDF.");
  if (file.size > MAX_SAMPLE_BYTES) return fail("Samples are limited to 16 MB.");
  const admin = createAdminClient();
  const ch = await activeChannel(admin, member.orgId, channelId);
  if (!ch.ok) return fail(ch.error);
  try {
    const client = await clientForChannel(admin, ch.channel);
    const handle = await client.uploadTemplateSample({
      data: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      fileName:
        slugifyName(file.name.replace(/\.[^.]+$/, "")) +
        file.name.slice(file.name.lastIndexOf(".")).toLowerCase(),
    });
    return { ok: true, data: { handle, name: file.name, format } };
  } catch (err) {
    return fail(metaError(err, "The upload failed."));
  }
}
