"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePerm } from "@/lib/auth/session";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  attachCardSample,
  attachHeaderSample,
  deleteTemplate,
  duplicateTemplate,
  installGallery,
  markReviewed,
  saveDraft,
  setArchived,
  setVariableMap,
  submitTemplate,
  syncOne,
  type Ctx,
  type Result,
} from "@/lib/templates/service";
import { templateDraftSchema } from "@/lib/templates/schema";

export type ActionResult<T = object> = Result<T>;

const uuid = z.string().uuid();
const PERM = "templates.manage";

async function ctx(): Promise<Ctx> {
  const member = await requirePerm(PERM);
  return { admin: createAdminClient(), orgId: member.orgId, userId: member.userId };
}

function done<T extends Result<object>>(r: T): T {
  if (r.ok) revalidatePath("/templates");
  return r;
}

const bad = (error = "That request was not valid."): { ok: false; error: string } => ({
  ok: false,
  error,
});

export async function saveTemplateDraft(input: {
  id: string | null;
  channelId: string;
  draft: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const c = await ctx();
  const draft = templateDraftSchema.safeParse(input.draft);
  if (
    !draft.success ||
    !uuid.safeParse(input.channelId).success ||
    (input.id !== null && !uuid.safeParse(input.id).success)
  )
    return bad();
  return done(await saveDraft(c, { id: input.id, channelId: input.channelId, draft: draft.data }));
}

async function throttled(c: Ctx): Promise<{ ok: false; error: string } | null> {
  const r = await checkRateLimit(
    c.admin,
    "template-submit",
    c.userId,
    RATE_RULES.templateSubmitPerUser,
  );
  return r.allowed
    ? null
    : { ok: false, error: `Too many submissions. Try again in ${waitText(r.retryAfter)}.` };
}

/** Sends a template to Meta (create or edit). `draft` is given when editing an approved template. */
export async function submitTemplateToMeta(
  id: string,
  draft?: unknown,
): Promise<ActionResult<{ status: string }>> {
  const c = await ctx();
  if (!uuid.safeParse(id).success) return bad();
  const parsed = draft === undefined ? undefined : templateDraftSchema.safeParse(draft);
  if (parsed && !parsed.success) return bad();
  const limited = await throttled(c);
  if (limited) return limited;
  return done(await submitTemplate(c, id, parsed?.data));
}

export async function uploadHeaderSample(
  formData: FormData,
): Promise<ActionResult<{ path: string }>> {
  const c = await ctx();
  const id = formData.get("id");
  const file = formData.get("file");
  if (typeof id !== "string" || !uuid.safeParse(id).success || !(file instanceof File))
    return bad();
  const data = new Uint8Array(await file.arrayBuffer());
  return done(
    await attachHeaderSample(c, id, {
      data,
      mimeType: file.type,
      filename: file.name.slice(0, 120),
    }),
  );
}

export async function uploadCardSample(formData: FormData): Promise<ActionResult<{ path: string }>> {
  const c = await ctx();
  const id = formData.get("id");
  const index = Number(formData.get("index"));
  const file = formData.get("file");
  if (typeof id !== "string" || !uuid.safeParse(id).success || !Number.isInteger(index) || index < 0 || index > 9 || !(file instanceof File)) return bad();
  const data = new Uint8Array(await file.arrayBuffer());
  return done(await attachCardSample(c, id, index, { data, mimeType: file.type, filename: file.name.slice(0, 120) }));
}

export async function duplicateTemplateAction(
  id: string,
  to: { name?: string; language?: string; channelId?: string },
): Promise<ActionResult<{ id: string }>> {
  const c = await ctx();
  if (!uuid.safeParse(id).success || (to.channelId && !uuid.safeParse(to.channelId).success))
    return bad();
  return done(
    await duplicateTemplate(c, id, {
      name: to.name?.slice(0, 200),
      language: to.language?.slice(0, 10),
      channelId: to.channelId,
    }),
  );
}

export async function archiveTemplate(
  id: string,
  archived: boolean,
  force = false,
): Promise<ActionResult> {
  const c = await ctx();
  if (!uuid.safeParse(id).success) return bad();
  return done(await setArchived(c, id, archived, force));
}

export async function deleteTemplateAction(
  id: string,
  force = false,
): Promise<ActionResult<{ hard: boolean }>> {
  const c = await ctx();
  if (!uuid.safeParse(id).success) return bad();
  return done(await deleteTemplate(c, id, force));
}

export async function saveVariableMap(
  id: string,
  map: Record<string, string>,
): Promise<ActionResult> {
  const c = await ctx();
  const parsed = z.record(z.string().max(40), z.string().max(60)).safeParse(map);
  if (!uuid.safeParse(id).success || !parsed.success) return bad();
  return done(await setVariableMap(c, id, parsed.data));
}

export async function markTemplateReviewed(id: string): Promise<ActionResult> {
  const c = await ctx();
  if (!uuid.safeParse(id).success) return bad();
  return done(await markReviewed(c, id));
}

export async function installStarterTemplates(
  channelId: string,
  keys: string[],
): Promise<ActionResult<{ created: number; skipped: number }>> {
  const c = await ctx();
  const parsed = z.array(z.string().max(80)).max(60).safeParse(keys);
  if (!uuid.safeParse(channelId).success || !parsed.success) return bad();
  return done(await installGallery(c, channelId, parsed.data));
}

export async function syncTemplates(
  channelId: string,
): Promise<ActionResult<{ synced: number; removed: number }>> {
  const c = await ctx();
  if (!uuid.safeParse(channelId).success) return bad();
  return done(await syncOne(c, channelId));
}
