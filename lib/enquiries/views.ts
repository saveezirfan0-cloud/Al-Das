/**
 * Enquiry list scoping as filters: the Open / Closed switch, the pipeline rail and
 * saved-view filters are all AND-ed into one lib/filters AST.
 */
import { and, cond, emptyFilter, type Filter } from "@/lib/filters/ast";

export const ENQUIRY_SCOPES = ["open", "closed", "all"] as const;
export type EnquiryScope = (typeof ENQUIRY_SCOPES)[number];

export function isScope(v: string | null | undefined): v is EnquiryScope {
  return ENQUIRY_SCOPES.includes(v as EnquiryScope);
}

export function scopeFilter(scope: EnquiryScope): Filter {
  if (scope === "open") return { include: and(cond("status", "eq", "open")) };
  if (scope === "closed") return { include: and(cond("status", "neq", "open")) };
  return emptyFilter();
}

export function pipelineFilter(pipelineId: string | null | undefined): Filter {
  return pipelineId ? { include: and(cond("pipeline", "eq", pipelineId)) } : emptyFilter();
}

/** AND-combines filters, ignoring empties. Same semantics as lib/contacts/views combineFilters. */
export function combineEnquiryFilters(...filters: Array<Filter | null | undefined>): Filter {
  const present = filters.filter(
    (f): f is Filter => !!f && (f.include.children.length > 0 || !!f.exclude?.children.length),
  );
  if (present.length === 0) return emptyFilter();
  if (present.length === 1) return present[0];
  return {
    include: and(...present.map((f) => f.include)),
    exclude: present.some((f) => f.exclude && f.exclude.children.length)
      ? {
          type: "group",
          logic: "or",
          children: present.flatMap((f) => (f.exclude ? [f.exclude] : [])),
        }
      : null,
  };
}

export function buildEnquiryFilter(input: {
  scope: EnquiryScope;
  pipelineId?: string | null;
  filter?: Filter | null;
}): Filter {
  return combineEnquiryFilters(
    scopeFilter(input.scope),
    pipelineFilter(input.pipelineId),
    input.filter,
  );
}
