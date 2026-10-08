import "server-only";

import {
  escapeLike,
  ParamBag,
  compileFilter,
  compileOrderBy,
  type SortSpec,
} from "@/lib/filters/to-sql";
import type { Filter } from "@/lib/filters/ast";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export type ContactTag = { id: string; name: string; color: string };

export type ContactListRow = Omit<Tables<"contacts">, "custom"> & {
  custom: Record<string, unknown>;
  tags: ContactTag[];
};

export type ContactQuery = {
  orgId: string;
  registry: FieldRegistry;
  filter?: Filter | null;
  search?: string | null;
  sort?: SortSpec[] | null;
  page?: number;
  pageSize?: number;
  timezone?: string;
};

export type ContactPage = {
  rows: ContactListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export const MAX_PAGE_SIZE = 500;

/** Free-text search over name, email, external id and phones (primary + alternates). */
export function compileSearch(q: string | null | undefined, bag: ParamBag, alias = "c"): string {
  const s = (q ?? "").trim();
  if (!s) return "true";
  const like = bag.text(`%${escapeLike(s)}%`);
  const parts = [
    `${alias}.full_name ilike ${like} escape '\\'`,
    `${alias}.email ilike ${like} escape '\\'`,
    `${alias}.external_id ilike ${like} escape '\\'`,
  ];
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 3) {
    const phoneLike = bag.text(`%${digits}%`);
    parts.push(`${alias}.phone_e164 like ${phoneLike}`);
    parts.push(
      `exists (select 1 from public.contact_phones r where r.contact_id = ${alias}.id and r.phone_e164 like ${phoneLike})`,
    );
  }
  return `(${parts.join(" or ")})`;
}

/** Compiles filter + search into one predicate with a shared param bag. */
export function compileContactPredicate(
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  search: string | null | undefined,
  timezone = "UTC",
): { sql: string; params: unknown[] } {
  const bag = new ParamBag();
  const f = compileFilter(filter, registry, { timezone }, bag);
  const s = compileSearch(search, bag);
  const parts = [f.sql, s].filter((p) => p !== "true");
  return { sql: parts.length ? parts.join(" and ") : "true", params: bag.params };
}

function toRow(
  c: Tables<"contacts"> & { contact_tags?: Array<{ tags: ContactTag | null }> | null },
): ContactListRow {
  const { contact_tags, ...rest } = c;
  return {
    ...rest,
    custom: (rest.custom && typeof rest.custom === "object" && !Array.isArray(rest.custom)
      ? (rest.custom as Record<string, unknown>)
      : {}) as Record<string, unknown>,
    tags: (contact_tags ?? [])
      .map((ct) => ct.tags)
      .filter((t): t is ContactTag => !!t)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Loads full rows (with tags) for a list of ids, preserving order. */
export async function fetchContactsByIds(
  admin: AdminClient,
  orgId: string,
  ids: string[],
): Promise<ContactListRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("contacts")
    .select("*, contact_tags(tags(id, name, color))")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw new Error(`contacts fetch failed: ${error.message}`);
  const byId = new Map((data ?? []).map((c) => [c.id, toRow(c)]));
  return ids.map((id) => byId.get(id)).filter((r): r is ContactListRow => !!r);
}

/** Runs a filtered, sorted, paginated contact query through the contacts_search RPC. */
export async function queryContacts(admin: AdminClient, q: ContactQuery): Promise<ContactPage> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? 100)));
  const { sql, params } = compileContactPredicate(q.registry, q.filter, q.search, q.timezone);
  const orderBy = compileOrderBy(q.sort, q.registry);

  const { data, error } = await admin.rpc("contacts_search", {
    p_org_id: q.orgId,
    p_where: sql,
    p_params: params as never,
    p_order_by: orderBy,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error(`contacts_search failed: ${error.message}`);
  const ids = (data ?? []).map((r) => r.id);
  const total = data && data.length > 0 ? Number(data[0].total) : 0;
  const rows = await fetchContactsByIds(admin, q.orgId, ids);
  return { rows, total, page, pageSize };
}

export async function countContacts(
  admin: AdminClient,
  orgId: string,
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  timezone = "UTC",
): Promise<number> {
  const { sql, params } = compileContactPredicate(registry, filter, null, timezone);
  const { data, error } = await admin.rpc("contacts_count", {
    p_org_id: orgId,
    p_where: sql,
    p_params: params as never,
  });
  if (error) throw new Error(`contacts_count failed: ${error.message}`);
  return Number(data ?? 0);
}

/** All ids matching a predicate (exports, static-segment fills). Capped at `limit`. */
export async function matchingContactIds(
  admin: AdminClient,
  orgId: string,
  registry: FieldRegistry,
  filter: Filter | null | undefined,
  search: string | null | undefined,
  timezone = "UTC",
  limit = 50_000,
): Promise<string[]> {
  const { sql, params } = compileContactPredicate(registry, filter, search, timezone);
  const { data, error } = await admin.rpc("contacts_ids", {
    p_org_id: orgId,
    p_where: sql,
    p_params: params as never,
    p_limit: limit,
  });
  if (error) throw new Error(`contacts_ids failed: ${error.message}`);
  return (data ?? []) as unknown as string[];
}
