"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { patchConfig } from "@/lib/integrations/accounts";
import { REVIEW_VALUE_SOURCES } from "@/lib/integrations/reviews/config";
import { loadReviewTemplate } from "@/lib/integrations/reviews/server";
import { validateReviewUrl } from "@/lib/integrations/reviews/url";
import { REVIEW_PROBE_CONTEXT, reviewValues } from "@/lib/integrations/reviews/values";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const linksSchema = z.object({
  links: z.record(z.string().uuid(), z.string().max(600)),
});

/** Saves the Google review link of each location (blank clears it). Only https links on Google's own hosts are accepted. */
export async function saveReviewLinks(input: z.input<typeof linksSchema>): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = linksSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const ids = Object.keys(p.data.links);
  if (ids.length === 0) return { ok: true, message: "Nothing to save." };
  const { data: own } = await admin
    .from("locations")
    .select("id, review_url")
    .eq("org_id", member.orgId)
    .in("id", ids);
  const known = new Map((own ?? []).map((l) => [l.id, l.review_url]));
  const changed: string[] = [];
  const cleared: string[] = [];
  for (const [id, raw] of Object.entries(p.data.links)) {
    if (!known.has(id)) return { ok: false, error: "Unknown location." };
    const text = raw.trim();
    if (!text) {
      if (known.get(id)) cleared.push(id);
      continue;
    }
    const v = validateReviewUrl(text);
    if (!v.ok) return { ok: false, error: v.error };
    if (known.get(id) !== v.url) changed.push(id);
  }
  for (const [id, raw] of Object.entries(p.data.links)) {
    const text = raw.trim();
    const v = text ? validateReviewUrl(text) : null;
    const url = v && v.ok ? v.url : null;
    if (text && !url) continue;
    if (known.get(id) === url) continue;
    const { error } = await admin
      .from("locations")
      .update({ review_url: url })
      .eq("id", id)
      .eq("org_id", member.orgId);
    if (error) return { ok: false, error: "Could not save the links." };
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.review_links_saved",
    entity: "integration",
    entityId: "google_reviews",
    // Location ids only: never the link itself.
    diff: { changed, cleared },
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: "Links saved." };
}

const templateSchema = z.object({
  templateId: z.string().uuid().nullable(),
  variableMap: z.record(z.string().max(40), z.string().max(40)),
});

/** Chooses the WhatsApp template used for review requests and maps its variables. */
export async function saveReviewTemplate(
  input: z.input<typeof templateSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = templateSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const known = new Set<string>(REVIEW_VALUE_SOURCES.map((s) => s.key));
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.data.variableMap)) if (v && known.has(v)) map[k] = v;
  if (p.data.templateId) {
    const tpl = await loadReviewTemplate(admin, member.orgId, p.data.templateId);
    if (!tpl) return { ok: false, error: "Template not found." };
    // keep only variables the template actually has
    const probe = reviewValues(
      tpl.components as MetaTemplateComponent[],
      map,
      REVIEW_PROBE_CONTEXT,
    );
    for (const k of Object.keys(map)) if (!(k in probe.values)) delete map[k];
  }
  const saved = await patchConfig(admin, member.orgId, "google_reviews", {
    template_id: p.data.templateId,
    variable_map: p.data.templateId ? JSON.stringify(map) : null,
  });
  if (!saved.ok) return saved;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.review_template_saved",
    entity: "integration",
    entityId: "google_reviews",
    diff: { template_id: p.data.templateId, mapped: Object.keys(map).length },
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: "Template saved." };
}
