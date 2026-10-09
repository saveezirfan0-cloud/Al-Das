/**
 * The enquiry filter model used by the toolbar, saved views and export. A filter is plain JSON
 * (validated by Zod) that compiles to a list of clauses; applying the clauses to a supabase-js
 * query is a separate step, so the logic is unit-testable without a database.
 */
import { z } from "zod";

import { ENQUIRY_STATUSES } from "@/lib/enquiries/status";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const enquiryFilterSchema = z.object({
  pipeline_id: uuid.optional(),
  /** Open / Closed switch. An explicit `status` list overrides it. */
  scope: z.enum(["open", "closed", "all"]).default("open"),
  status: z.array(z.enum(ENQUIRY_STATUSES)).max(4).optional(),
  stage_ids: z.array(uuid).max(50).optional(),
  /** User ids, or the literals "me" and "unassigned". */
  assignees: z
    .array(z.union([uuid, z.literal("me"), z.literal("unassigned")]))
    .max(50)
    .optional(),
  contact_id: uuid.optional(),
  sources: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  channel_ids: z.array(uuid).max(20).optional(),
  location_ids: z.array(uuid).max(50).optional(),
  department_ids: z.array(uuid).max(50).optional(),
  specialist_ids: z.array(uuid).max(100).optional(),
  service_ids: z.array(uuid).max(100).optional(),
  created_from: day.optional(),
  created_to: day.optional(),
  closed_from: day.optional(),
  closed_to: day.optional(),
  search: z.string().trim().max(100).optional(),
});

export type EnquiryFilter = z.infer<typeof enquiryFilterSchema>;

export const EMPTY_FILTER: EnquiryFilter = enquiryFilterSchema.parse({});

export type Clause =
  | { op: "eq"; column: string; value: string }
  | { op: "in"; column: string; value: string[] }
  | { op: "gte" | "lte"; column: string; value: string }
  | { op: "or"; expr: string };

/** Compiles a filter to clauses. `search` is handled by searchExpression (it needs contact ids). */
export function filterToClauses(f: EnquiryFilter, ctx: { userId: string }): Clause[] {
  const out: Clause[] = [];
  if (f.pipeline_id) out.push({ op: "eq", column: "pipeline_id", value: f.pipeline_id });

  if (f.status?.length) out.push({ op: "in", column: "status", value: [...f.status] });
  else if (f.scope === "open") out.push({ op: "eq", column: "status", value: "open" });
  else if (f.scope === "closed")
    out.push({ op: "in", column: "status", value: ["won", "lost", "disqualified"] });

  if (f.stage_ids?.length) out.push({ op: "in", column: "stage_id", value: f.stage_ids });

  if (f.assignees?.length) {
    const ids = f.assignees
      .filter((a) => a !== "unassigned")
      .map((a) => (a === "me" ? ctx.userId : a));
    const unassigned = f.assignees.includes("unassigned");
    const uniq = [...new Set(ids)];
    if (unassigned && uniq.length)
      out.push({ op: "or", expr: `assignee_id.is.null,assignee_id.in.(${uniq.join(",")})` });
    else if (unassigned) out.push({ op: "or", expr: "assignee_id.is.null" });
    else out.push({ op: "in", column: "assignee_id", value: uniq });
  }

  if (f.contact_id) out.push({ op: "eq", column: "contact_id", value: f.contact_id });
  if (f.sources?.length) out.push({ op: "in", column: "source", value: f.sources });
  if (f.channel_ids?.length) out.push({ op: "in", column: "channel_id", value: f.channel_ids });
  if (f.location_ids?.length) out.push({ op: "in", column: "location_id", value: f.location_ids });
  if (f.department_ids?.length)
    out.push({ op: "in", column: "department_id", value: f.department_ids });
  if (f.specialist_ids?.length)
    out.push({ op: "in", column: "specialist_id", value: f.specialist_ids });
  if (f.service_ids?.length) out.push({ op: "in", column: "service_id", value: f.service_ids });

  if (f.created_from)
    out.push({ op: "gte", column: "created_at", value: `${f.created_from}T00:00:00.000Z` });
  if (f.created_to)
    out.push({ op: "lte", column: "created_at", value: `${f.created_to}T23:59:59.999Z` });
  if (f.closed_from)
    out.push({ op: "gte", column: "closed_at", value: `${f.closed_from}T00:00:00.000Z` });
  if (f.closed_to)
    out.push({ op: "lte", column: "closed_at", value: `${f.closed_to}T23:59:59.999Z` });
  return out;
}

/** The minimal query surface the clauses need (supabase-js builders satisfy it after a cast). */
export type ClauseQuery<Q> = {
  eq(column: string, value: string): Q;
  in(column: string, values: string[]): Q;
  gte(column: string, value: string): Q;
  lte(column: string, value: string): Q;
  or(expression: string): Q;
};

/** Loose builder type: supabase-js query builders are cast to it before clauses are applied. */
export type LooseQuery = {
  eq(column: string, value: string): LooseQuery;
  in(column: string, values: string[]): LooseQuery;
  gte(column: string, value: string): LooseQuery;
  lte(column: string, value: string): LooseQuery;
  or(expression: string): LooseQuery;
};

export function applyClauses<Q extends ClauseQuery<Q>>(query: Q, clauses: Clause[]): Q {
  let q = query;
  for (const c of clauses) {
    switch (c.op) {
      case "eq":
        q = q.eq(c.column, c.value);
        break;
      case "in":
        q = q.in(c.column, c.value);
        break;
      case "gte":
        q = q.gte(c.column, c.value);
        break;
      case "lte":
        q = q.lte(c.column, c.value);
        break;
      case "or":
        q = q.or(c.expr);
        break;
    }
  }
  return q;
}

/** Characters that would change the meaning of a PostgREST filter expression. */
function cleanTerm(term: string): string {
  return term
    .replace(/[,()*%\\"':;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PostgREST `or` expression for the search box: title text, enquiry number, or a contact the
 * service already resolved from the same term. Null when there is nothing to search for.
 */
export function searchExpression(term: string | undefined, contactIds: string[]): string | null {
  const t = cleanTerm(term ?? "");
  if (!t) return null;
  const parts = [`title.ilike.%${t}%`];
  const digits = t.replace(/^#|^enq-?/i, "");
  if (/^\d{1,9}$/.test(digits)) parts.push(`number.eq.${Number(digits)}`);
  const ids = contactIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  if (ids.length) parts.push(`contact_id.in.(${ids.join(",")})`);
  return parts.join(",");
}

/** Safe term for the contact lookup that feeds searchExpression. */
export function searchTerm(term: string | undefined): string {
  return cleanTerm(term ?? "");
}
