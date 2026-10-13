/**
 * Phase 20c: restricted enquiry view per member (memberships.enquiry_scope). The rule itself lives in ONE place, the SQL
 * function app.enquiry_visible_to() (20261025000100_routing_presence.sql), which both the RLS policy and the service-role
 * list queries call. This file only decides whether a server query needs the extra predicate and builds it. Pure.
 *
 *   all   every enquiry (the default: no behaviour change)
 *   own   assigned to me, or unassigned and created by me
 *   team  assigned to me or to someone in one of my teams, or unassigned
 */
import { z } from "zod";

export const ENQUIRY_VIEW_SCOPES = ["all", "team", "own"] as const;
export type EnquiryViewScope = (typeof ENQUIRY_VIEW_SCOPES)[number];

export const ENQUIRY_VIEW_SCOPE_LABELS: Record<EnquiryViewScope, string> = {
  all: "All enquiries",
  team: "Their team's and unassigned",
  own: "Only their own",
};

export const enquiryViewScopeSchema = z.enum(ENQUIRY_VIEW_SCOPES);

export type EnquiryViewer = { userId: string; scope: EnquiryViewScope };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An unknown or missing stored value is treated as the narrowest scope (fail closed). */
export function parseEnquiryScope(value: unknown): EnquiryViewScope {
  const parsed = enquiryViewScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : "own";
}

/**
 * The SQL predicate a service-role enquiry query must add for this viewer, or null when nothing is restricted.
 * `param` binds a value and returns its SQL accessor (lib/filters ParamBag), so the user id is never interpolated.
 */
export function enquiryScopeSql(
  viewer: EnquiryViewer | null | undefined,
  param: (value: string) => string,
  alias = "e",
): string | null {
  if (!viewer || viewer.scope === "all") return null;
  if (!UUID.test(viewer.userId)) return "false";
  return `app.enquiry_visible_to(${alias}.org_id, (${param(viewer.userId)})::uuid, ${alias}.assignee_id, ${alias}.created_by)`;
}
