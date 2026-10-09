import "server-only";

import {
  compileFilter,
  compileOrderBy,
  escapeLike,
  ParamBag,
  type SortSpec,
} from "@/lib/filters/to-sql";
import type { Filter } from "@/lib/filters/ast";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import { buildPortalFieldRegistry } from "@/lib/portal/filter-registry";
import type { PortalObjectDef, PortalRow } from "@/lib/portal/types";
import { loose } from "@/lib/portal/db";
import type { AdminClient } from "@/lib/supabase/admin";

export const MAX_PAGE_SIZE = 500;
export const MAX_EXPORT = 50_000;

export type PortalQuery = {
  orgId: string;
  def: PortalObjectDef;
  filter?: Filter | null;
  search?: string | null;
  sort?: SortSpec[] | null;
  page?: number;
  pageSize?: number;
  timezone?: string;
};

export type PortalPage = { rows: PortalRow[]; total: number; page: number; pageSize: number };

/** Free-text search over the object's declared searchColumns (identifiers come from code). */
export function compilePortalSearch(
  def: PortalObjectDef,
  q: string | null | undefined,
  bag: ParamBag,
): string {
  const s = (q ?? "").trim();
  if (!s || def.searchColumns.length === 0) return "true";
  const like = bag.text(`%${escapeLike(s)}%`);
  const parts = def.searchColumns.map((c) => {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) throw new Error(`invalid search column ${c}`);
    return `c.${c} ilike ${like} escape '\\'`;
  });
  return `(${parts.join(" or ")})`;
}

/** Filter + search compiled into one predicate over `public.<table> c` with a shared param bag. */
export function compilePortalPredicate(
  def: PortalObjectDef,
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  search: string | null | undefined,
  timezone = "UTC",
): { sql: string; params: unknown[] } {
  const bag = new ParamBag();
  const f = compileFilter(filter, registry, { timezone }, bag);
  const s = compilePortalSearch(def, search, bag);
  const parts = [f.sql, s].filter((p) => p !== "true");
  return { sql: parts.length ? parts.join(" and ") : "true", params: bag.params };
}

function orderBy(def: PortalObjectDef, registry: FieldRegistry, sort?: SortSpec[] | null): string {
  const requested = sort && sort.length > 0 ? sort : def.defaultSort;
  return compileOrderBy(requested, registry);
}

export async function queryPortal(
  admin: AdminClient,
  q: PortalQuery,
  registry: FieldRegistry = buildPortalFieldRegistry(q.def),
): Promise<PortalPage> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? 100)));
  const { sql, params } = compilePortalPredicate(q.def, registry, q.filter, q.search, q.timezone);
  const { data, error } = await loose(admin).rpc("portal_search", {
    p_org_id: q.orgId,
    p_object_key: q.def.key,
    p_where: sql,
    p_params: params,
    p_order_by: orderBy(q.def, registry, q.sort),
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error(`portal_search failed: ${error.message}`);
  const list = (data ?? []) as Array<{ row_data: PortalRow; total: number | string }>;
  const total = list.length > 0 ? Number(list[0].total) : 0;
  return { rows: list.map((r) => r.row_data), total, page, pageSize };
}

export async function countPortal(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  timezone = "UTC",
): Promise<number> {
  const { sql, params } = compilePortalPredicate(def, registry, filter, null, timezone);
  const { data, error } = await loose(admin).rpc("portal_count", {
    p_org_id: orgId,
    p_object_key: def.key,
    p_where: sql,
    p_params: params,
  });
  if (error) throw new Error(`portal_count failed: ${error.message}`);
  return Number(data ?? 0);
}

export async function matchingPortalIds(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  search: string | null | undefined,
  limit = MAX_EXPORT,
  timezone = "UTC",
): Promise<string[]> {
  const { sql, params } = compilePortalPredicate(def, registry, filter, search, timezone);
  const { data, error } = await loose(admin).rpc("portal_ids", {
    p_org_id: orgId,
    p_object_key: def.key,
    p_where: sql,
    p_params: params,
    p_limit: limit,
  });
  if (error) throw new Error(`portal_ids failed: ${error.message}`);
  return (data ?? []) as string[];
}

/** Loads rows by id (org-scoped), preserving the requested order. */
export async function fetchPortalRows(
  admin: AdminClient,
  orgId: string,
  def: PortalObjectDef,
  ids: string[],
): Promise<PortalRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await loose(admin)
    .from(def.table)
    .select("*")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw new Error(`${def.table} fetch failed: ${error.message}`);
  const byId = new Map(((data ?? []) as PortalRow[]).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is PortalRow => !!r);
}
