/**
 * Phase B branch access for service-role queries (RLS does not apply to the service role). Pure: the server loaders
 * apply the same rule as app.location_visible_to() through these helpers (lib/branches/access.ts has the rule).
 *
 * `filterIds` is what lib/branches/server.ts `branchView()` returns: the branch ids a query must keep to, plus rows
 * with no branch, or `null` for no filter at all (the default for an unrestricted member).
 */
import { branchFilterIds, branchOrFilter, canSeeLocation, type BranchAccess } from "./access";

/** Is a row with this branch inside the filter? Rows with no branch always are. */
export function inBranchFilter(
  filterIds: readonly string[] | null | undefined,
  locationId: string | null | undefined,
): boolean {
  if (!filterIds || !locationId) return true;
  return filterIds.includes(locationId);
}

/** Keeps in-memory rows to the filter (same rule as `withBranchFilter`). */
export function keepInBranches<T extends { location_id?: string | null }>(
  rows: readonly T[],
  filterIds: readonly string[] | null | undefined,
): T[] {
  return filterIds ? rows.filter((r) => inBranchFilter(filterIds, r.location_id)) : [...rows];
}

/**
 * Adds the branch condition to a PostgREST query: the allowed branches plus rows without one. A `null` filter leaves
 * the query untouched, so an unrestricted member's query is exactly what it was before branches existed.
 */
export function withBranchFilter<Q extends { or(filters: string): Q }>(
  query: Q,
  filterIds: readonly string[] | null | undefined,
  column = "location_id",
): Q {
  return filterIds ? query.or(branchOrFilter(filterIds, column)) : query;
}

/**
 * The filter for a request that names a branch explicitly (a location picker): that branch when the member may work
 * there, else nothing (`[]`); with no branch named, the member's view (`fallback`).
 */
export function explicitBranchFilter(
  access: BranchAccess,
  locationId: string | null | undefined,
  fallback: readonly string[] | null,
): string[] | null {
  if (locationId) return canSeeLocation(access, locationId) ? [locationId] : [];
  return fallback ? [...fallback] : null;
}

/** The access-only filter (no switcher choice): every branch the member may see, or null when unrestricted. */
export function accessFilterIds(access: BranchAccess): string[] | null {
  return branchFilterIds(access, null);
}
