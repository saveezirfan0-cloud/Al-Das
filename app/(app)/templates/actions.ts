"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { emit } from "@/lib/events/emit";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { channelsToSync, syncTemplatesForChannel } from "@/lib/whatsapp/sync";
import {
  blockingDraftIssues,
  toComponents,
  toCreateRequest,
  validateBuilder,
  type BuilderState,
  type ValidationIssue,
} from "@/lib/whatsapp/template-builder";
import { isMappableField } from "@/lib/whatsapp/template-fields";
import { checkSample, sampleStoragePath } from "@/lib/whatsapp/template-media";
import { builderStateSchema } from "@/lib/whatsapp/template-schema";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ActionResult<T extends object = object> =
  | ({ ok: true; message?: string } & T)
  | { ok: false; error: string; issues?: ValidationIssue[]; id?: string };

const BUCKET = "wa-media";

function fail(err: unknown, fallback: string): { ok: false; error: string } {
  if (err instanceof WhatsAppApiError) {
    const detail = err.details ? ` ${err.details}` : "";
    return { ok: false, error: `Meta: ${err.mapped.message}${detail}` };
  }
  if (err instanceof Error && /ENCRYPTION_KEY|access token/i.test(err.message))
    return { ok: false, error: err.message };
  console.error("[templates]", err instanceof Error ? err.message : err);
  return { ok: false, error: fallback };
}

async function ownChannel(admin: AdminClient, orgId: string, channelId: string) {
  const { data } = await admin
    .from("channels")
    .select("*")
    .eq("id", channelId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

async function ownTemplate(admin: AdminClient, orgId: string, id: string) {
  const { data } = await admin
    .from("wa_templates")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

/** Storage paths of header / card samples, keyed "header" / "card.<i>". */
function mediaPathsOf(state: BuilderState): Record<string, string> {
  const out: Record<string, string> = {};
  const h = state.header;
  if (h.format !== "NONE" && h.format !== "TEXT" && h.mediaPath) out.header = h.mediaPath;
  state.cards.forEach((c, i) => {
    if (c.mediaPath) out[`card.${i}`] = c.mediaPath;
  });
  return out;
}

/** Keeps only mappings for variables the template really has, with known fields. */
function pruneVariableMap(
  map: Record<string, string>,
  components: MetaTemplateComponent[],
): Record<string, string> {
  const keys = new Set(templateVariables(components).map((v) => v.key));
  return Object.fromEntries(
    Object.entries(map).filter(([k, v]) => keys.has(k) && isMappableField(v)),
  );
}

const saveSchema = z.object({
  id: z.uuid().optional(),
  channel_id: z.uuid(),
  state: builderStateSchema,
  gallery_key: z.string().max(80).optional(),
  variable_map: z.record(z.string(), z.string()).optional(),
});
export type SaveTemplateInput = z.input<typeof saveSchema>;

function rowFromState(state: BuilderState, channel: Tables<"channels">) {
  const components = toComponents(state);
  return {
    channel_id: channel.id,
    waba_id: channel.waba_id,
    name: state.name,
    language: state.language,
    category: state.category,
    type: state.type,
    parameter_format: "positional",
    components: components as unknown as NonNullable<Json>,
    media_paths: mediaPathsOf(state) as unknown as NonNullable<Json>,
  };
}

const DUPLICATE =
  "A template with this name and language already exists for this WhatsApp account.";

/** Creates or updates a draft. Submitted templates are changed through submitTemplate. */
export async function saveTemplate(
  input: SaveTemplateInput,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("templates.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, channel_id, state, gallery_key } = parsed.data;

  const blocking = blockingDraftIssues(validateBuilder(state));
  if (blocking.length) return { ok: false, error: blocking[0].message, issues: blocking };

  const admin = createAdminClient();
  const channel = await ownChannel(admin, member.orgId, channel_id);
  if (!channel) return { ok: false, error: "Choose a WhatsApp number." };

  const fields = rowFromState(state, channel);
  const variable_map = pruneVariableMap(
    parsed.data.variable_map ?? {},
    fields.components as unknown as MetaTemplateComponent[],
  );

  try {
    if (id) {
      const existing = await ownTemplate(admin, member.orgId, id);
      if (!existing) return { ok: false, error: "Template not found." };
      if (existing.meta_template_id)
        return {
          ok: false,
          error: "This template is already with Meta. Use “Submit changes” to edit it.",
        };
      const { error } = await admin
        .from("wa_templates")
        .update({
          ...fields,
          variable_map: variable_map as unknown as NonNullable<Json>,
          submit_error: null,
        })
        .eq("id", id)
        .eq("org_id", member.orgId);
      if (error)
        return { ok: false, error: error.code === "23505" ? DUPLICATE : "Could not save." };
      revalidatePath("/templates");
      return { ok: true, id, message: "Draft saved." };
    }
    const { data, error } = await admin
      .from("wa_templates")
      .insert({
        ...fields,
        org_id: member.orgId,
        status: "DRAFT",
        created_by: member.userId,
        gallery_key: gallery_key ?? null,
        variable_map: variable_map as unknown as NonNullable<Json>,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.code === "23505" ? DUPLICATE : "Could not save." };
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "template.created",
      entity: "template",
      entityId: data.id,
      diff: { name: state.name, language: state.language, gallery_key: gallery_key ?? null },
    });
    revalidatePath("/templates");
    return { ok: true, id: data.id, message: "Draft saved." };
  } catch (err) {
    return fail(err, "Could not save the template.");
  }
}

/** Re-uploads stored samples so every submission carries a fresh Meta handle. */
async function freshenSamples(
  admin: AdminClient,
  client: Awaited<ReturnType<typeof clientForChannel>>,
  state: BuilderState,
): Promise<BuilderState> {
  const appId = serverEnv().META_APP_ID;
  const next: BuilderState = JSON.parse(JSON.stringify(state));
  const refresh = async (path: string, fileName?: string) => {
    if (!appId) throw new Error("META_APP_ID is not set, so header samples cannot be uploaded.");
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error("The stored sample file is missing. Upload it again.");
    const bytes = new Uint8Array(await data.arrayBuffer());
    const res = await client.uploadTemplateSample(appId, {
      data: bytes,
      mimeType: data.type || "application/octet-stream",
      filename: fileName,
    });
    return res.handle;
  };
  const h = next.header;
  if (h.format !== "NONE" && h.format !== "TEXT" && h.mediaPath)
    h.handle = await refresh(h.mediaPath, h.fileName);
  for (const c of next.cards) if (c.mediaPath) c.handle = await refresh(c.mediaPath);
  return next;
}

/** Sends a template to Meta for review: creates it, or edits it when it already exists there. */
export async function submitTemplate(
  input: SaveTemplateInput,
): Promise<ActionResult<{ id: string; status: string }>> {
  const member = await requirePerm("templates.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, channel_id, gallery_key } = parsed.data;
  let state = parsed.data.state as BuilderState;

  const admin = createAdminClient();
  const channel = await ownChannel(admin, member.orgId, channel_id);
  if (!channel) return { ok: false, error: "Choose a WhatsApp number." };
  const existing = id ? await ownTemplate(admin, member.orgId, id) : null;
  if (id && !existing) return { ok: false, error: "Template not found." };

  // Fail closed: nothing reaches Meta until every rule passes. Stored samples count as uploaded.
  const preCheck: BuilderState = JSON.parse(JSON.stringify(state));
  if (
    preCheck.header.format !== "NONE" &&
    preCheck.header.format !== "TEXT" &&
    preCheck.header.mediaPath
  )
    preCheck.header.handle ||= "pending-refresh";
  preCheck.cards.forEach((c) => {
    if (c.mediaPath) c.handle ||= "pending-refresh";
  });
  const issues = validateBuilder(preCheck);
  if (issues.length) return { ok: false, error: issues[0].message, issues };

  if (existing?.meta_template_id) {
    if (existing.name !== state.name || existing.language !== state.language)
      return { ok: false, error: "A submitted template's name and language cannot change." };
    if (existing.category !== state.category && existing.status !== "REJECTED")
      return { ok: false, error: "Category can only change while a template is rejected." };
  } else {
    // Name clash with a different local row: stop before anything is sent.
    const { data: clash } = await admin
      .from("wa_templates")
      .select("id")
      .eq("waba_id", channel.waba_id)
      .eq("name", state.name)
      .eq("language", state.language)
      .maybeSingle();
    if (clash && clash.id !== id) return { ok: false, error: DUPLICATE };
  }

  const variable_map = pruneVariableMap(
    parsed.data.variable_map ??
      (existing?.variable_map as Record<string, string> | undefined) ??
      {},
    toComponents(state),
  );
  const now = new Date().toISOString();

  /** Persists the outcome as a draft/edit with the error text so nothing typed is lost. */
  async function keepWithError(message: string): Promise<string> {
    const fields = rowFromState(state, channel!);
    if (existing?.meta_template_id) {
      // The mirror must keep showing what Meta has: record only the error.
      await admin.from("wa_templates").update({ submit_error: message }).eq("id", existing.id);
      return existing.id;
    }
    if (existing) {
      await admin
        .from("wa_templates")
        .update({
          ...fields,
          submit_error: message,
          variable_map: variable_map as unknown as NonNullable<Json>,
        })
        .eq("id", existing.id);
      return existing.id;
    }
    const { data } = await admin
      .from("wa_templates")
      .insert({
        ...fields,
        org_id: member.orgId,
        status: "DRAFT",
        created_by: member.userId,
        gallery_key: gallery_key ?? null,
        submit_error: message,
        variable_map: variable_map as unknown as NonNullable<Json>,
      })
      .select("id")
      .single();
    return data?.id ?? "";
  }

  try {
    const client = await clientForChannel(admin, channel);
    state = await freshenSamples(admin, client, state);
    const final = validateBuilder(state);
    if (final.length) return { ok: false, error: final[0].message, issues: final };

    let metaId: string;
    let status: string;
    let category = state.category as string;
    if (existing?.meta_template_id) {
      await client.updateTemplate(existing.meta_template_id, {
        components: toComponents(state),
        ...(existing.status === "REJECTED" ? { category: state.category } : {}),
      });
      metaId = existing.meta_template_id;
      status = "PENDING";
    } else {
      const res = await client.createTemplate(toCreateRequest(state), channel.waba_id);
      metaId = res.id;
      status = res.status || "PENDING";
      category = res.category || category;
    }

    const fields = rowFromState(state, channel);
    const update = {
      ...fields,
      category,
      status,
      meta_template_id: metaId,
      submitted_at: now,
      submit_error: null,
      rejected_reason: null,
      variable_map: variable_map as unknown as NonNullable<Json>,
    };
    let rowId = existing?.id ?? "";
    if (existing) {
      await admin.from("wa_templates").update(update).eq("id", existing.id);
    } else {
      const { data, error } = await admin
        .from("wa_templates")
        .insert({
          ...update,
          org_id: member.orgId,
          created_by: member.userId,
          gallery_key: gallery_key ?? null,
        })
        .select("id")
        .single();
      if (error) {
        // Meta accepted it; the nightly/manual sync will mirror it. Say so.
        return fail(
          new Error(error.message),
          "Sent to Meta, but saving locally failed. Run Sync templates to pick it up.",
        );
      }
      rowId = data.id;
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: existing?.meta_template_id ? "template.edited" : "template.submitted",
      entity: "template",
      entityId: rowId,
      diff: { name: state.name, language: state.language, category, status },
    });
    await emit(member.orgId, "template.status_changed", { template_id: rowId, status });
    revalidatePath("/templates");
    return { ok: true, id: rowId, status, message: `Sent to Meta for review (${status}).` };
  } catch (err) {
    const f = fail(err, "Could not submit the template.");
    const savedId = await keepWithError(f.error);
    revalidatePath("/templates");
    return { ...f, id: savedId };
  }
}

const sampleSchema = z.object({
  channel_id: z.uuid(),
  kind: z.enum(["header", "card"]),
  format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"]),
});

/** Uploads a header / card sample to Storage and to Meta's Resumable Upload API. */
export async function uploadSample(
  formData: FormData,
): Promise<
  ActionResult<{ handle: string; path: string; fileName: string; previewUrl: string | null }>
> {
  const member = await requirePerm("templates.manage");
  const parsed = sampleSchema.safeParse({
    channel_id: formData.get("channel_id"),
    kind: formData.get("kind"),
    format: formData.get("format"),
  });
  const file = formData.get("file");
  if (!parsed.success || !(file instanceof File)) return { ok: false, error: "Choose a file." };
  const appId = serverEnv().META_APP_ID;
  if (!appId)
    return { ok: false, error: "META_APP_ID is not set, so samples cannot be uploaded to Meta." };

  const allowed =
    parsed.data.kind === "card" ? (["IMAGE", "VIDEO"] as const) : ([parsed.data.format] as const);
  const check = checkSample(file.type, file.size, allowed);
  if (!check.ok) return { ok: false, error: check.error };

  const admin = createAdminClient();
  const channel = await ownChannel(admin, member.orgId, parsed.data.channel_id);
  if (!channel) return { ok: false, error: "Choose a WhatsApp number first." };

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = sampleStoragePath(member.orgId, randomUUID(), check.ext);
    const { error: upError } = await admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upError) return { ok: false, error: "Could not store the file." };
    const client = await clientForChannel(admin, channel);
    const { handle } = await client.uploadTemplateSample(appId, {
      data: bytes,
      mimeType: file.type,
      filename: file.name.slice(0, 120),
    });
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600);
    return {
      ok: true,
      handle,
      path,
      fileName: file.name.slice(0, 120),
      previewUrl: signed?.signedUrl ?? null,
    };
  } catch (err) {
    return fail(err, "Upload failed.");
  }
}

/** Manual "Sync templates": one number's WABA, or every WABA of the workspace. */
export async function syncTemplates(channelId?: string): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  try {
    let channels: Tables<"channels">[];
    if (channelId) {
      const c = await ownChannel(admin, member.orgId, channelId);
      if (!c) return { ok: false, error: "Number not found." };
      channels = [c];
    } else {
      const { data } = await admin.from("channels").select("*").eq("org_id", member.orgId);
      channels = channelsToSync(data ?? []);
    }
    if (!channels.length) return { ok: false, error: "No active WhatsApp number to sync." };
    let synced = 0;
    let removed = 0;
    const errors: string[] = [];
    for (const c of channels) {
      try {
        const r = await syncTemplatesForChannel(admin, c);
        synced += r.synced;
        removed += r.removed;
      } catch (err) {
        errors.push(err instanceof WhatsAppApiError ? err.mapped.message : "sync failed");
      }
    }
    revalidatePath("/templates");
    if (errors.length && !synced) return { ok: false, error: `Sync failed: ${errors[0]}` };
    return {
      ok: true,
      message:
        `${synced} template${synced === 1 ? "" : "s"} synced` +
        (removed ? `, ${removed} archived (removed at Meta)` : "") +
        (errors.length ? `. ${errors.length} account(s) failed: ${errors[0]}` : "."),
    };
  } catch (err) {
    return fail(err, "Template sync failed.");
  }
}

/** Copies a template as a new draft ("<name>_copy"), optionally for another number or language. */
export async function duplicateTemplate(
  id: string,
  opts: { name?: string; channel_id?: string } = {},
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  const src = await ownTemplate(admin, member.orgId, id);
  if (!src) return { ok: false, error: "Template not found." };
  const channel = await ownChannel(admin, member.orgId, opts.channel_id ?? src.channel_id ?? "");
  if (!channel) return { ok: false, error: "Choose a WhatsApp number." };
  const base = (opts.name ?? `${src.name}_copy`)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 500);

  const { data: taken } = await admin
    .from("wa_templates")
    .select("name")
    .eq("waba_id", channel.waba_id)
    .eq("language", src.language)
    .like("name", `${base}%`);
  const names = new Set((taken ?? []).map((t) => t.name));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}_${n}`;

  // Media samples are copied so the duplicate owns its files.
  const paths = (src.media_paths ?? {}) as Record<string, string>;
  const newPaths: Record<string, string> = {};
  for (const [k, p] of Object.entries(paths)) {
    const ext = p.split(".").pop() ?? "bin";
    const np = sampleStoragePath(member.orgId, randomUUID(), ext);
    const { error } = await admin.storage.from(BUCKET).copy(p, np);
    if (!error) newPaths[k] = np;
  }

  const { data, error } = await admin
    .from("wa_templates")
    .insert({
      org_id: member.orgId,
      channel_id: channel.id,
      waba_id: channel.waba_id,
      name,
      language: src.language,
      category: src.category,
      type: src.type,
      parameter_format: src.parameter_format,
      components: src.components,
      variable_map: src.variable_map,
      retry_on_fail: src.retry_on_fail,
      media_paths: newPaths as unknown as NonNullable<Json>,
      status: "DRAFT",
      created_by: member.userId,
      gallery_key: src.gallery_key,
    })
    .select("id")
    .single();
  if (error)
    return { ok: false, error: error.code === "23505" ? DUPLICATE : "Could not duplicate." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.duplicated",
    entity: "template",
    entityId: data.id,
    diff: { from: src.id, name },
  });
  revalidatePath("/templates");
  return { ok: true, id: data.id, message: `Copied as “${name}”.` };
}

export async function archiveTemplate(id: string, archived: boolean): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  const t = await ownTemplate(admin, member.orgId, id);
  if (!t) return { ok: false, error: "Template not found." };
  const { error } = await admin
    .from("wa_templates")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not update the template." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: archived ? "template.archived" : "template.unarchived",
    entity: "template",
    entityId: id,
    diff: { name: t.name },
  });
  revalidatePath("/templates");
  return { ok: true, message: archived ? "Archived. It will not appear in pickers." : "Restored." };
}

/**
 * Deletes a template. Drafts are removed. Submitted templates are deleted at Meta
 * (this language only, by hsm_id) and kept locally as DELETED + archived so message
 * history that mentions them stays intact.
 */
export async function deleteTemplate(id: string): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  const t = await ownTemplate(admin, member.orgId, id);
  if (!t) return { ok: false, error: "Template not found." };
  try {
    if (t.meta_template_id) {
      const channel = t.channel_id ? await ownChannel(admin, member.orgId, t.channel_id) : null;
      if (!channel)
        return { ok: false, error: "The WhatsApp number for this template is not connected." };
      const client = await clientForChannel(admin, channel);
      await client.deleteTemplate(t.name, { wabaId: t.waba_id, hsmId: t.meta_template_id });
      await admin
        .from("wa_templates")
        .update({ status: "DELETED", archived_at: new Date().toISOString() })
        .eq("id", id);
    } else {
      const paths = Object.values((t.media_paths ?? {}) as Record<string, string>);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      await admin.from("wa_templates").delete().eq("id", id).eq("org_id", member.orgId);
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "template.deleted",
      entity: "template",
      entityId: id,
      diff: { name: t.name, language: t.language, at_meta: !!t.meta_template_id },
    });
    revalidatePath("/templates");
    return { ok: true, message: "Template deleted." };
  } catch (err) {
    return fail(err, "Could not delete the template.");
  }
}

const settingsSchema = z.object({
  variable_map: z.record(z.string(), z.string()),
  retry_on_fail: z.boolean(),
});

/** Variable mapper + per-template settings (retry on fail). Allowed in any status. */
export async function saveTemplateSettings(
  id: string,
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid settings." };
  const admin = createAdminClient();
  const t = await ownTemplate(admin, member.orgId, id);
  if (!t) return { ok: false, error: "Template not found." };
  const map = pruneVariableMap(
    parsed.data.variable_map,
    t.components as unknown as MetaTemplateComponent[],
  );
  const { error } = await admin
    .from("wa_templates")
    .update({
      variable_map: map as unknown as NonNullable<Json>,
      retry_on_fail: parsed.data.retry_on_fail,
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "template.settings_changed",
    entity: "template",
    entityId: id,
    diff: { mapped: Object.keys(map).length, retry_on_fail: parsed.data.retry_on_fail },
  });
  revalidatePath("/templates");
  return { ok: true, message: "Saved." };
}
