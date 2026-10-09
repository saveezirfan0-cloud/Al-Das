import "server-only";

import type { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/types";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

type UserClient = Awaited<ReturnType<typeof createClient>>;

export const TEMPLATE_PAGE_SIZE = 30;

/** Every status Meta reports, plus our local DRAFT. */
export const TEMPLATE_STATUSES = [
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
  "FLAGGED",
  "IN_APPEAL",
  "LIMIT_EXCEEDED",
  "LOCKED",
  "REINSTATED",
  "PENDING_DELETION",
  "ARCHIVED",
  "DELETED",
] as const;

export type TemplateListRow = Pick<
  Tables<"wa_templates">,
  | "id"
  | "name"
  | "language"
  | "category"
  | "status"
  | "type"
  | "waba_id"
  | "channel_id"
  | "rejected_reason"
  | "quality"
  | "archived_at"
  | "updated_at"
  | "meta_template_id"
  | "created_by"
  | "gallery_key"
  | "submitted_at"
> & {
  components: MetaTemplateComponent[];
  variable_map: Record<string, string>;
  preview: string;
};

const SELECT =
  "id, name, language, category, status, type, waba_id, channel_id, rejected_reason, quality, archived_at, updated_at, meta_template_id, created_by, gallery_key, submitted_at, components, variable_map";

export function toTemplateRow(r: Record<string, unknown>): TemplateListRow {
  const components = (r.components ?? []) as MetaTemplateComponent[];
  const map =
    r.variable_map && typeof r.variable_map === "object" && !Array.isArray(r.variable_map)
      ? Object.fromEntries(
          Object.entries(r.variable_map).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};
  return {
    ...(r as unknown as TemplateListRow),
    components,
    variable_map: map,
    preview: renderTemplatePreview(components, {}).body,
  };
}

export async function listTemplates(
  supabase: UserClient,
  orgId: string,
  opts: { waba?: string; status?: string; q?: string; archived?: boolean; page?: number } = {},
): Promise<{ rows: TemplateListRow[]; total: number; page: number }> {
  const page = Math.max(1, opts.page ?? 1);
  let b = supabase
    .from("wa_templates")
    .select(SELECT, { count: "exact" })
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .range((page - 1) * TEMPLATE_PAGE_SIZE, page * TEMPLATE_PAGE_SIZE - 1);
  b = opts.archived ? b.not("archived_at", "is", null) : b.is("archived_at", null);
  if (opts.waba) b = b.eq("waba_id", opts.waba);
  if (opts.status && opts.status !== "all") b = b.eq("status", opts.status);
  const term = opts.q?.replace(/[%,()]/g, " ").trim();
  if (term) b = b.ilike("name", `%${term}%`);
  const { data, count, error } = await b;
  if (error) throw new Error(`listTemplates: ${error.message}`);
  return {
    rows: (data ?? []).map((r) => toTemplateRow(r as Record<string, unknown>)),
    total: count ?? 0,
    page,
  };
}

export async function getTemplate(
  supabase: UserClient,
  orgId: string,
  id: string,
): Promise<TemplateListRow | null> {
  const { data } = await supabase
    .from("wa_templates")
    .select(SELECT)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data ? toTemplateRow(data as Record<string, unknown>) : null;
}
