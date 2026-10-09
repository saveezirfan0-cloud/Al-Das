import "server-only";

import { randomUUID } from "node:crypto";

import { recordAudit } from "@/lib/audit";
import {
  appointmentSlotsUsing,
  canEdit,
  canHardDelete,
  canSubmit,
  isInUse,
  lockedFields,
  submitMode,
  usageSummary,
  type Usage,
} from "@/lib/templates/rules";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import type { WhatsAppClient } from "@/lib/whatsapp/client";
import { syncTemplatesForChannel } from "@/lib/whatsapp/sync";
import {
  checkSampleFile,
  componentsToDraft,
  draftKind,
  draftToComponents,
  staleVariableMapKeys,
  VARIABLE_SOURCES,
  type TemplateDraft,
} from "@/lib/whatsapp/template-draft";
import { galleryEntry } from "@/lib/whatsapp/template-gallery";
import { validateDraft, type Issue } from "@/lib/whatsapp/template-validate";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export const SAMPLE_BUCKET = "wa-template-media";

export type TemplateRecord = Tables<"wa_templates">;
type ChannelRow = Pick<
  Tables<"channels">,
  "id" | "org_id" | "name" | "phone_number_id" | "waba_id" | "status"
>;

export type Ctx = {
  admin: AdminClient;
  orgId: string;
  userId: string;
  /** Test seam: build the Meta client for a channel. */
  makeClient?: (channel: ChannelRow) => Promise<WhatsAppClient>;
  appId?: string | undefined;
  now?: () => number;
};

export type Result<T = object> =
  ({ ok: true } & T) | { ok: false; error: string; issues?: Issue[]; confirm?: boolean };

const fail = (error: string, issues?: Issue[]): { ok: false; error: string; issues?: Issue[] } => ({
  ok: false,
  error,
  issues,
});
const needsConfirm = (error: string): { ok: false; error: string; confirm: true } => ({
  ok: false,
  error,
  confirm: true,
});
const nowIso = (ctx: Ctx) => new Date(ctx.now?.() ?? Date.now()).toISOString();

async function loadTemplate(ctx: Ctx, id: string): Promise<TemplateRecord | null> {
  const { data } = await ctx.admin
    .from("wa_templates")
    .select("*")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  return data ?? null;
}

async function loadChannel(ctx: Ctx, channelId: string | null): Promise<ChannelRow | null> {
  if (!channelId) return null;
  const { data } = await ctx.admin
    .from("channels")
    .select("id, org_id, name, phone_number_id, waba_id, status")
    .eq("id", channelId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  return data ?? null;
}

function client(ctx: Ctx, channel: ChannelRow): Promise<WhatsAppClient> {
  return ctx.makeClient ? ctx.makeClient(channel) : clientForChannel(ctx.admin, channel);
}

function metaErrorText(err: unknown): string {
  if (err instanceof WhatsAppApiError) {
    const text = `${err.mapped.message}${err.details ? ` — ${err.details}` : ""}`;
    return redactText(text, 400);
  }
  return redactText(err, 300);
}

/** A stored sample path is only trusted if it lives under this org and this template. */
export function ownSamplePath(orgId: string, templateId: string, p: unknown): string | undefined {
  if (typeof p !== "string") return undefined;
  const prefix = `${orgId}/${templateId}/`;
  if (!p.startsWith(prefix) || p.includes("..") || p.includes("//") || p.length > 300)
    return undefined;
  return /^[A-Za-z0-9._\-/]+$/.test(p) ? p : undefined;
}

function toDraft(t: TemplateRecord): TemplateDraft {
  const d = componentsToDraft(t.components as unknown as MetaTemplateComponent[], {
    name: t.name,
    language: t.language,
    category: t.category,
    variableMap: t.variable_map as Record<string, string>,
  });
  // The sample is stored once in Storage; the Meta handle in components may have expired.
  if (
    t.header_sample_path &&
    (d.header.format === "IMAGE" || d.header.format === "VIDEO" || d.header.format === "DOCUMENT")
  )
    d.header = { ...d.header, samplePath: t.header_sample_path };
  const cardPaths = Array.isArray(t.card_sample_paths) ? (t.card_sample_paths as unknown[]) : [];
  d.cards = d.cards.map((c, i) => ({
    ...c,
    header: {
      ...c.header,
      samplePath: typeof cardPaths[i] === "string" ? (cardPaths[i] as string) : undefined,
    },
  }));
  return d;
}

/** Replaces any sample paths a client sent with ones this org owns for this template. */
function trustSamples(
  ctx: Ctx,
  row: Pick<TemplateRecord, "id" | "header_sample_path" | "card_sample_paths">,
  d: TemplateDraft,
): TemplateDraft {
  const out: TemplateDraft = JSON.parse(JSON.stringify(d));
  if (
    out.header.format === "IMAGE" ||
    out.header.format === "VIDEO" ||
    out.header.format === "DOCUMENT"
  )
    out.header = {
      ...out.header,
      samplePath: ownSamplePath(ctx.orgId, row.id, row.header_sample_path),
    };
  const stored = Array.isArray(row.card_sample_paths) ? (row.card_sample_paths as unknown[]) : [];
  out.cards = out.cards.map((c, i) => {
    const claimed = c.header.samplePath;
    const trusted =
      ownSamplePath(ctx.orgId, row.id, claimed) ?? ownSamplePath(ctx.orgId, row.id, stored[i]);
    return { ...c, header: { ...c.header, samplePath: trusted } };
  });
  return out;
}

function rowFields(d: TemplateDraft) {
  const map = { ...d.variableMap };
  for (const k of staleVariableMapKeys(d)) delete map[k];
  return {
    name: d.name,
    language: d.language,
    category: d.category,
    type: draftKind(d),
    components: draftToComponents(d) as unknown as NonNullable<Json>,
    variable_map: map as NonNullable<Json>,
    parameter_format: "positional",
    card_sample_paths: d.cards.map((c) => c.header.samplePath ?? null) as NonNullable<Json>,
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** Creates or updates a local draft (also used to save edits to a rejected / paused template before resubmitting). */
export async function saveDraft(
  ctx: Ctx,
  input: { id: string | null; channelId: string; draft: TemplateDraft },
): Promise<Result<{ id: string }>> {
  const { draft } = input;
  if (!draft.name.trim()) return fail("Give the template a name.");
  const channel = await loadChannel(ctx, input.channelId);
  if (!channel) return fail("Choose one of your WhatsApp numbers.");

  if (input.id) {
    const row = await loadTemplate(ctx, input.id);
    if (!row) return fail("Template not found.");
    if (!["DRAFT", "REJECTED", "PAUSED"].includes(row.status))
      return fail(
        "Only drafts and rejected or paused templates can be saved locally. Use “Submit changes” for an approved template.",
      );
    const locked = lockedFields(row);
    if (locked.includes("name") && draft.name !== row.name)
      return fail(
        "The name cannot change once the template has been sent to Meta. Duplicate it to use a new name.",
      );
    if (locked.includes("language") && draft.language !== row.language)
      return fail("The language cannot change once the template has been sent to Meta.");
    const sample = row.header_sample_path;
    const trusted = trustSamples(ctx, row, draft);
    const { error } = await ctx.admin
      .from("wa_templates")
      .update({
        ...rowFields(trusted),
        ...(locked.includes("channel") ? {} : { channel_id: channel.id, waba_id: channel.waba_id }),
        header_sample_path: sample,
        last_error: null,
      })
      .eq("id", row.id)
      .eq("org_id", ctx.orgId);
    if (error)
      return fail(
        error.code === "23505"
          ? "A template with that name and language already exists on this number."
          : "Could not save the template.",
      );
    await recordAudit(ctx.admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "template.saved",
      entity: "template",
      entityId: row.id,
      diff: { name: draft.name, language: draft.language },
    });
    return { ok: true, id: row.id };
  }

  const { data, error } = await ctx.admin
    .from("wa_templates")
    .insert({
      org_id: ctx.orgId,
      channel_id: channel.id,
      waba_id: channel.waba_id,
      status: "DRAFT",
      source: "local",
      ...rowFields(draft),
    })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      error?.code === "23505"
        ? "A template with that name and language already exists on this number."
        : "Could not create the template.",
    );
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.created",
    entity: "template",
    entityId: data.id,
    diff: { name: draft.name, language: draft.language },
  });
  return { ok: true, id: data.id };
}

/** Attaches (or replaces) the header sample file for a draft. Bytes go to private Storage; Meta gets them at submit time. */
export async function attachHeaderSample(
  ctx: Ctx,
  id: string,
  file: { data: Uint8Array; mimeType: string; filename: string },
): Promise<Result<{ path: string }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Save the template first, then attach the sample.");
  const draft = toDraft(row);
  const format = draft.header.format;
  if (format !== "IMAGE" && format !== "VIDEO" && format !== "DOCUMENT")
    return fail("Choose an image, video or document header first.");
  const problem = checkSampleFile(format, { mimeType: file.mimeType, size: file.data.byteLength });
  if (problem) return fail(problem);
  const ext = file.mimeType.split("/")[1].replace("jpeg", "jpg");
  const path = `${ctx.orgId}/${row.id}/${randomUUID()}.${ext}`;
  const up = await ctx.admin.storage
    .from(SAMPLE_BUCKET)
    .upload(path, file.data, { contentType: file.mimeType, upsert: false });
  if (up.error) return fail("Could not store the sample file.");
  if (row.header_sample_path)
    await ctx.admin.storage.from(SAMPLE_BUCKET).remove([row.header_sample_path]);
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ header_sample_path: path })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Could not attach the sample file.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.sample_attached",
    entity: "template",
    entityId: row.id,
    diff: { format },
  });
  return { ok: true, path };
}

/** Stores the sample for one carousel card (same rules as the header sample). */
export async function attachCardSample(
  ctx: Ctx,
  id: string,
  index: number,
  file: { data: Uint8Array; mimeType: string; filename: string },
): Promise<Result<{ path: string }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Save the template first, then attach the sample.");
  const draft = toDraft(row);
  const card = draft.cards[index];
  if (!card) return fail("That card does not exist. Save the template first.");
  const problem = checkSampleFile(card.header.format, {
    mimeType: file.mimeType,
    size: file.data.byteLength,
  });
  if (problem) return fail(problem);
  const ext = file.mimeType.split("/")[1].replace("jpeg", "jpg");
  const path = `${ctx.orgId}/${row.id}/card${index}-${randomUUID()}.${ext}`;
  const up = await ctx.admin.storage
    .from(SAMPLE_BUCKET)
    .upload(path, file.data, { contentType: file.mimeType, upsert: false });
  if (up.error) return fail("Could not store the sample file.");
  const paths = Array.isArray(row.card_sample_paths)
    ? [...(row.card_sample_paths as unknown[])]
    : [];
  const old = paths[index];
  paths[index] = path;
  while (paths.length < draft.cards.length) paths.push(null);
  if (typeof old === "string") await ctx.admin.storage.from(SAMPLE_BUCKET).remove([old]);
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ card_sample_paths: paths as NonNullable<Json> })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Could not attach the sample file.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.sample_attached",
    entity: "template",
    entityId: row.id,
    diff: { card: index },
  });
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Submit / edit on Meta
// ---------------------------------------------------------------------------

/**
 * Sends a template to Meta: creates it when it has never been submitted, otherwise edits the existing
 * one. `draft` (optional) replaces the stored components first, which is how an approved template is edited.
 */
export async function submitTemplate(
  ctx: Ctx,
  id: string,
  draftOverride?: TemplateDraft,
): Promise<Result<{ status: string }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  const gate = canSubmit(row);
  if (!gate.ok) return fail(gate.reason);
  const mode = submitMode(row);
  if (mode === "edit") {
    const edit = canEdit(row, ctx.now?.());
    if (!edit.ok) return fail(edit.reason);
  }
  const channel = await loadChannel(ctx, row.channel_id);
  if (!channel) return fail("This template is not attached to a WhatsApp number.");
  if (channel.status !== "active") return fail("That WhatsApp number is paused or disconnected.");

  const draft = trustSamples(ctx, row, draftOverride ?? toDraft(row));
  if (draftOverride) {
    const locked = lockedFields(row);
    if (locked.includes("name") && draft.name !== row.name)
      return fail("The name cannot change once the template is on Meta.");
    if (locked.includes("language") && draft.language !== row.language)
      return fail("The language cannot change once the template is on Meta.");
    if (locked.includes("category") && draft.category !== row.category)
      return fail("The category of an approved template cannot be changed here.");
  }

  let meta: WhatsAppClient;
  try {
    meta = await client(ctx, channel);
  } catch (err) {
    return fail(metaErrorText(err));
  }

  try {
    // Header sample → fresh Meta handle (handles expire, so always re-upload from the stored copy).
    const h = draft.header;
    if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT") {
      const samplePath = h.samplePath ?? row.header_sample_path;
      if (samplePath) {
        const dl = await ctx.admin.storage.from(SAMPLE_BUCKET).download(samplePath);
        if (dl.error || !dl.data)
          return fail("The header sample file is missing. Upload it again.");
        const bytes = new Uint8Array(await dl.data.arrayBuffer());
        const mime =
          h.format === "IMAGE"
            ? samplePath.endsWith(".png")
              ? "image/png"
              : "image/jpeg"
            : h.format === "VIDEO"
              ? "video/mp4"
              : "application/pdf";
        const up = await meta.uploadTemplateSample(ctx.appId ?? process.env.META_APP_ID ?? "", {
          data: bytes,
          mimeType: mime,
          filename: samplePath.split("/").pop(),
        });
        draft.header = { ...h, handle: up.handle, samplePath };
      }
    }
    for (const card of draft.cards) {
      const path = card.header.samplePath;
      if (!path) continue;
      const dl = await ctx.admin.storage.from(SAMPLE_BUCKET).download(path);
      if (dl.error || !dl.data) return fail("A card sample file is missing. Upload it again.");
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const mime =
        card.header.format === "VIDEO"
          ? "video/mp4"
          : path.endsWith(".png")
            ? "image/png"
            : "image/jpeg";
      const up = await meta.uploadTemplateSample(ctx.appId ?? process.env.META_APP_ID ?? "", {
        data: bytes,
        mimeType: mime,
        filename: path.split("/").pop(),
      });
      card.header = { ...card.header, handle: up.handle };
    }

    const check = validateDraft(draft);
    if (!check.ok) return fail(check.errors[0].message, check.errors);

    const components = draftToComponents(draft);
    let status: string;
    let category = draft.category as string;
    let metaId = row.meta_template_id;
    if (mode === "create") {
      const created = await meta.createTemplate(
        {
          name: draft.name,
          language: draft.language,
          category: draft.category,
          parameter_format: "POSITIONAL",
          components,
          allow_category_change: true,
        },
        channel.waba_id,
      );
      metaId = created.id;
      status = created.status;
      category = created.category ?? category;
    } else {
      await meta.updateTemplate(row.meta_template_id!, { components });
      status = row.status;
      try {
        const fresh = await meta.getTemplate(row.meta_template_id!);
        status = fresh.status;
        category = fresh.category;
      } catch {
        // The edit went through; the nightly sync will correct the status.
      }
    }

    const { error } = await ctx.admin
      .from("wa_templates")
      .update({
        ...rowFields(draft),
        category,
        components: components as unknown as NonNullable<Json>,
        meta_template_id: metaId,
        status,
        submitted_at: row.submitted_at ?? nowIso(ctx),
        last_edited_at: mode === "edit" ? nowIso(ctx) : row.last_edited_at,
        header_sample_path:
          draft.header.format === "IMAGE" ||
          draft.header.format === "VIDEO" ||
          draft.header.format === "DOCUMENT"
            ? (draft.header.samplePath ?? row.header_sample_path)
            : row.header_sample_path,
        last_error: null,
        rejected_reason: null,
      })
      .eq("id", row.id)
      .eq("org_id", ctx.orgId);
    if (error)
      return fail(
        "Meta accepted the template but it could not be saved here. Run a sync to pick it up.",
      );
    await recordAudit(ctx.admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: mode === "create" ? "template.submitted" : "template.edited",
      entity: "template",
      entityId: row.id,
      diff: { name: draft.name, language: draft.language, status },
    });
    return { ok: true, status };
  } catch (err) {
    const text = metaErrorText(err);
    await ctx.admin
      .from("wa_templates")
      .update({ last_error: text })
      .eq("id", row.id)
      .eq("org_id", ctx.orgId);
    await recordAudit(ctx.admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "template.submit_failed",
      entity: "template",
      entityId: row.id,
      diff: { name: row.name, code: err instanceof WhatsAppApiError ? err.code : null },
    });
    return fail(text);
  }
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

export async function duplicateTemplate(
  ctx: Ctx,
  id: string,
  to: { name?: string; language?: string; channelId?: string },
): Promise<Result<{ id: string }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  const channel = await loadChannel(ctx, to.channelId ?? row.channel_id);
  if (!channel) return fail("Choose one of your WhatsApp numbers.");
  const draft = toDraft(row);
  draft.name = (to.name ?? `${row.name}_copy`)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 512);
  draft.language = to.language ?? row.language;
  // Handles are tied to the app and expire; the stored sample files are what carries over (copied below).
  const fromHeader = row.header_sample_path;
  const fromCards = Array.isArray(row.card_sample_paths)
    ? (row.card_sample_paths as unknown[])
    : [];
  if (
    draft.header.format === "IMAGE" ||
    draft.header.format === "VIDEO" ||
    draft.header.format === "DOCUMENT"
  )
    draft.header = { format: draft.header.format };
  draft.cards = draft.cards.map((c) => ({ ...c, header: { format: c.header.format } }));
  const { data, error } = await ctx.admin
    .from("wa_templates")
    .insert({
      org_id: ctx.orgId,
      channel_id: channel.id,
      waba_id: channel.waba_id,
      status: "DRAFT",
      source: "local",
      needs_review: row.needs_review,
      ...rowFields(draft),
    })
    .select("id")
    .single();
  if (error || !data)
    return fail(
      error?.code === "23505"
        ? "A template with that name and language already exists on that number. Pick another name."
        : "Could not duplicate the template.",
    );

  const copy = async (from: unknown, tag: string): Promise<string | null> => {
    const src = ownSamplePath(ctx.orgId, row.id, from);
    if (!src) return null;
    const dl = await ctx.admin.storage.from(SAMPLE_BUCKET).download(src);
    if (dl.error || !dl.data) return null;
    const dest = `${ctx.orgId}/${data.id}/${tag}-${randomUUID()}.${src.split(".").pop()}`;
    const up = await ctx.admin.storage
      .from(SAMPLE_BUCKET)
      .upload(dest, new Uint8Array(await dl.data.arrayBuffer()), { upsert: false });
    return up.error ? null : dest;
  };
  const headerCopy = await copy(fromHeader, "header");
  const cardCopies = await Promise.all(fromCards.map((p, i) => copy(p, `card${i}`)));
  if (headerCopy || cardCopies.some(Boolean)) {
    await ctx.admin
      .from("wa_templates")
      .update({
        header_sample_path: headerCopy,
        card_sample_paths: cardCopies as NonNullable<Json>,
      })
      .eq("id", data.id)
      .eq("org_id", ctx.orgId);
  }
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.duplicated",
    entity: "template",
    entityId: data.id,
    diff: { from: row.id, name: draft.name },
  });
  return { ok: true, id: data.id };
}

export async function templateUsage(
  ctx: Ctx,
  t: Pick<TemplateRecord, "id" | "internal_key">,
): Promise<Usage> {
  const [{ data: org }, { count }] = await Promise.all([
    ctx.admin.from("orgs").select("settings").eq("id", ctx.orgId).single(),
    ctx.admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .eq("direction", "out")
      .eq("kind", "template")
      .gte("at", new Date((ctx.now?.() ?? Date.now()) - 30 * 86_400_000).toISOString())
      .filter("payload->send->>template_id", "eq", t.id),
  ]);
  const appt = (
    org?.settings as { appointments?: { templates?: Record<string, string | null> } } | null
  )?.appointments?.templates;
  return {
    appointmentSlots: appointmentSlotsUsing(appt, t.id),
    clinicalKey: t.internal_key,
    sendsLast30Days: count ?? 0,
  };
}

export async function setArchived(
  ctx: Ctx,
  id: string,
  archived: boolean,
  force = false,
): Promise<Result<{ usage?: string[] }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  if (archived) {
    const usage = await templateUsage(ctx, row);
    if (isInUse(usage) && !force)
      return needsConfirm(`This template is ${usageSummary(usage).join("; ")}. Archive it anyway?`);
  }
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ archived_at: archived ? nowIso(ctx) : null })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Could not update the template.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: archived ? "template.archived" : "template.unarchived",
    entity: "template",
    entityId: row.id,
    diff: { name: row.name },
  });
  return { ok: true };
}

export async function deleteTemplate(
  ctx: Ctx,
  id: string,
  force = false,
): Promise<Result<{ hard: boolean }>> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  const usage = await templateUsage(ctx, row);
  if (isInUse(usage) && !force)
    return needsConfirm(`This template is ${usageSummary(usage).join("; ")}. Delete it anyway?`);

  if (canHardDelete(row, usage)) {
    if (row.header_sample_path)
      await ctx.admin.storage.from(SAMPLE_BUCKET).remove([row.header_sample_path]);
    const { error } = await ctx.admin
      .from("wa_templates")
      .delete()
      .eq("id", row.id)
      .eq("org_id", ctx.orgId);
    if (error) return fail("Could not delete the template.");
    await recordAudit(ctx.admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "template.deleted",
      entity: "template",
      entityId: row.id,
      diff: { name: row.name, hard: true },
    });
    return { ok: true, hard: true };
  }

  if (row.meta_template_id) {
    const channel = await loadChannel(ctx, row.channel_id);
    if (!channel) return fail("This template is not attached to a WhatsApp number.");
    try {
      const meta = await client(ctx, channel);
      await meta.deleteTemplate(row.name, { wabaId: channel.waba_id, hsmId: row.meta_template_id });
    } catch (err) {
      return fail(metaErrorText(err));
    }
  }
  // Rows that messages reference are kept (archived), never removed.
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ status: "DELETED", archived_at: nowIso(ctx) })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Deleted on Meta, but the local copy could not be updated. Run a sync.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.deleted",
    entity: "template",
    entityId: row.id,
    diff: { name: row.name, hard: false },
  });
  return { ok: true, hard: false };
}

export async function setVariableMap(
  ctx: Ctx,
  id: string,
  map: Record<string, string>,
): Promise<Result> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  const allowed = new Set<string>(VARIABLE_SOURCES.map((s) => s.key));
  const live = new Set(
    toDraft(row)
      .body.match(/\{\{\s*(\d+)\s*\}\}/g)
      ?.map((m) => `body.${m.replace(/\D/g, "")}`) ?? [],
  );
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    if (!allowed.has(v)) return fail(`“${v}” is not a known source.`);
    if (!live.has(k)) return fail(`${k} is not a variable in this template.`);
    clean[k] = v;
  }
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ variable_map: clean as NonNullable<Json> })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Could not save the mapping.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.variables_mapped",
    entity: "template",
    entityId: row.id,
    diff: { name: row.name, count: Object.keys(clean).length },
  });
  return { ok: true };
}

export async function markReviewed(ctx: Ctx, id: string): Promise<Result> {
  const row = await loadTemplate(ctx, id);
  if (!row) return fail("Template not found.");
  if (!row.needs_review) return { ok: true };
  const { error } = await ctx.admin
    .from("wa_templates")
    .update({ needs_review: false, reviewed_at: nowIso(ctx), reviewed_by: ctx.userId })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId);
  if (error) return fail("Could not update the template.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.reviewed",
    entity: "template",
    entityId: row.id,
    diff: { name: row.name, language: row.language },
  });
  return { ok: true };
}

/** Installs gallery entries as drafts on one number. Existing (name, language) pairs are left alone. */
export async function installGallery(
  ctx: Ctx,
  channelId: string,
  keys: string[],
): Promise<Result<{ created: number; skipped: number }>> {
  const channel = await loadChannel(ctx, channelId);
  if (!channel) return fail("Choose one of your WhatsApp numbers.");
  let created = 0;
  let skipped = 0;
  for (const key of keys) {
    const g = galleryEntry(key);
    if (!g) {
      skipped++;
      continue;
    }
    const { data: existing } = await ctx.admin
      .from("wa_templates")
      .select("id")
      .eq("waba_id", channel.waba_id)
      .eq("name", g.draft.name)
      .eq("language", g.draft.language)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }
    const { error } = await ctx.admin.from("wa_templates").insert({
      org_id: ctx.orgId,
      channel_id: channel.id,
      waba_id: channel.waba_id,
      status: "DRAFT",
      source: "gallery",
      gallery_key: g.key,
      needs_review: !g.reviewed,
      ...rowFields(g.draft),
    });
    if (error) skipped++;
    else created++;
  }
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "template.gallery_installed",
    entity: "channel",
    entityId: channel.id,
    diff: { created, skipped },
  });
  return { ok: true, created, skipped };
}

/** Manual and nightly sync for one number (Settings → Channels uses the same function). */
export async function syncOne(
  ctx: Ctx,
  channelId: string,
): Promise<Result<{ synced: number; removed: number }>> {
  const channel = await loadChannel(ctx, channelId);
  if (!channel) return fail("Channel not found.");
  try {
    const r = await syncTemplatesForChannel(ctx.admin, channel);
    return { ok: true, ...r };
  } catch (err) {
    return fail(metaErrorText(err));
  }
}

export { toDraft };
