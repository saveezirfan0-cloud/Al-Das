import "server-only";

import { ENQUIRY_ALIAS } from "@/lib/enquiries/registry";
import type { Filter } from "@/lib/filters/ast";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import { ParamBag, compileFilter, compileOrderBy, escapeLike, type SortSpec } from "@/lib/filters/to-sql";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export const MAX_PAGE_SIZE = 500;

/** Row shape the UI works with: the enquiry plus the labels it displays. */
export type EnquiryRow = Omit<Tables<"enquiries">, "custom"> & {
  custom: Record<string, unknown>;
  contact: { id: string; full_name: string; phone_e164: string | null } | null;
};

export type EnquiryQuery = {
  orgId: string;
  registry: FieldRegistry;
  filter?: Filter | null;
  search?: string | null;
  sort?: SortSpec[] | null;
  page?: number;
  pageSize?: number;
  /** Restrict to one stage (Kanban column fetch). */
  stageId?: string | null;
  timezone?: string;
};

export type EnquiryPage = { rows: EnquiryRow[]; total: number; page: number; pageSize: number };

/** Compiles the filter AST to a predicate over `e`. Search is handled inside the RPC. */
export function compileEnquiryPredicate(
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  timezone = "UTC",
): { sql: string; params: unknown[] } {
  const bag = new ParamBag();
  const f = compileFilter(filter, registry, { timezone, alias: ENQUIRY_ALIAS }, bag);
  return { sql: f.sql, params: bag.params };
}

/** Escapes LIKE wildcards for the RPC's free-text search; blank → null. */
export function searchTerm(q: string | null | undefined): string | null {
  const s = (q ?? "").trim();
  return s ? escapeLike(s).slice(0, 100) : null;
}

type RawRow = Tables<"enquiries"> & {
  contacts: { id: string; full_name: string; phone_e164: string | null } | null;
};

function toRow(r: RawRow): EnquiryRow {
  const { contacts, ...rest } = r;
  return {
    ...rest,
    custom: (rest.custom && typeof rest.custom === "object" && !Array.isArray(rest.custom)
      ? rest.custom
      : {}) as Record<string, unknown>,
    contact: contacts,
  };
}

/** Loads rows (with the linked contact's name and phone) for ids, preserving order. */
export async function fetchEnquiriesByIds(
  admin: AdminClient,
  orgId: string,
  ids: string[],
): Promise<EnquiryRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("enquiries")
    .select("*, contacts(id, full_name, phone_e164)")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw new Error(`enquiries fetch failed: ${error.message}`);
  const byId = new Map((data ?? []).map((r) => [r.id, toRow(r as unknown as RawRow)]));
  return ids.map((id) => byId.get(id)).filter((r): r is EnquiryRow => !!r);
}

export async function queryEnquiries(admin: AdminClient, q: EnquiryQuery): Promise<EnquiryPage> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? 100)));
  const { sql, params } = compileEnquiryPredicate(q.registry, q.filter, q.timezone);
  const orderBy = compileOrderBy(q.sort, q.registry, { alias: ENQUIRY_ALIAS });
  const { data, error } = await admin.rpc("enquiries_search", {
    p_org_id: q.orgId,
    p_where: sql,
    p_params: params as never,
    p_order_by: q.sort?.length ? orderBy : `${ENQUIRY_ALIAS}.stage_entered_at desc`,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_q: searchTerm(q.search) ?? undefined,
    p_stage_id: q.stageId ?? undefined,
  });
  if (error) throw new Error(`enquiries_search failed: ${error.message}`);
  const ids = (data ?? []).map((r) => r.id);
  const total = data && data.length > 0 ? Number(data[0].total) : 0;
  return { rows: await fetchEnquiriesByIds(admin, q.orgId, ids), total, page, pageSize };
}

/** Per-stage counts for the Kanban headers (same filter + search). */
export async function stageCounts(
  admin: AdminClient,
  q: Pick<EnquiryQuery, "orgId" | "registry" | "filter" | "search" | "timezone">,
): Promise<Record<string, number>> {
  const { sql, params } = compileEnquiryPredicate(q.registry, q.filter, q.timezone);
  const { data, error } = await admin.rpc("enquiries_stage_counts", {
    p_org_id: q.orgId,
    p_where: sql,
    p_params: params as never,
    p_q: searchTerm(q.search) ?? undefined,
  });
  if (error) throw new Error(`enquiries_stage_counts failed: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.stage_id, Number(r.total)]));
}

/** All ids matching a filter (bulk "select all N", export). Capped. */
export async function matchingEnquiryIds(
  admin: AdminClient,
  q: Pick<EnquiryQuery, "orgId" | "registry" | "filter" | "search" | "timezone">,
  limit = 50_000,
): Promise<string[]> {
  const { sql, params } = compileEnquiryPredicate(q.registry, q.filter, q.timezone);
  const { data, error } = await admin.rpc("enquiries_ids", {
    p_org_id: q.orgId,
    p_where: sql,
    p_params: params as never,
    p_q: searchTerm(q.search) ?? undefined,
    p_limit: limit,
  });
  if (error) throw new Error(`enquiries_ids failed: ${error.message}`);
  return (data ?? []) as unknown as string[];
}
