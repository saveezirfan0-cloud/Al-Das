/**
 * Phase B branch access for service-role queries (RLS does not apply to the service role). Pure: the server loaders
 * apply the same rule as app.location_visible_to() through these helpers (lib/branches/access.ts has the rule).
 *
 * `filterIds` is what lib/branches/server.ts `branchView()` returns: the branch ids a query must keep to, plus rows
 * with no branch, or `null` for no filter at all (the default for an unrestricted member).
 */
import { ALL_BRANCHES, branchFilterIds, branchOrFilter, type BranchAccess } from "./access";

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

/** The access-only filter (no switcher choice): every branch the member may see, or null when unrestricted. */
export function accessFilterIds(access: BranchAccess): string[] | null {
  return branchFilterIds(access, null);
}

/**
 * The branch ids a list keeps to when its own filter may override the switcher (inbox, tasks): an explicit branch
 * narrows to it (never past the member's branches: an unallowed one leaves only rows without a branch), "all" means
 * every branch the member may see, and null follows the switcher's view (`branchView().filterIds`). Null = no filter.
 */
export function viewBranchIds(
  choice: string | null | undefined,
  view: { access: BranchAccess; filterIds: string[] | null },
): string[] | null {
  if (choice === ALL_BRANCHES) return branchFilterIds(view.access, null);
  if (choice) return branchFilterIds(view.access, choice);
  return view.filterIds;
}
