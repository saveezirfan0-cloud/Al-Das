/**
 * Branch access (Phase B, docs/34_CLINIC_OS_PLAN.md). Pure: shared by the server loaders, the branch switcher and
 * tests. The database rule is app.location_visible_to(); these functions follow it for service-role reads.
 *
 *   scope 'all'       every branch (the default)
 *   scope 'selected'  only the branches in `ids` (one or several); rows with no branch stay visible
 *
 * The switcher's choice narrows what a person sees further (one branch, or all the branches they may see); it is a
 * preference kept in the `pulse_branch` cookie and never widens access.
 */
export const BRANCH_COOKIE = "pulse_branch";
export const ALL_BRANCHES = "all";

export type BranchScope = "all" | "selected";
export type BranchAccess = { scope: BranchScope; ids: readonly string[]; home: string | null };

export function parseBranchScope(v: unknown): BranchScope {
  return v === "selected" ? "selected" : "all";
}

export function readBranchAccess(m: {
  branchScope?: BranchScope;
  branchIds?: readonly string[];
  homeLocationId?: string | null;
}): BranchAccess {
  return {
    scope: m.branchScope ?? "all",
    ids: m.branchIds ?? [],
    home: m.homeLocationId ?? null,
  };
}

/** May this person see a row that belongs to `locationId`? A row with no branch is visible to everyone. */
export function canSeeLocation(
  access: BranchAccess,
  locationId: string | null | undefined,
): boolean {
  if (!locationId || access.scope === "all") return true;
  return access.ids.includes(locationId);
}

/** The branches this person may work in, in the order given. */
export function allowedLocations<T extends { id: string }>(
  locations: readonly T[],
  access: BranchAccess,
): T[] {
  return locations.filter((l) => canSeeLocation(access, l.id));
}

/**
 * The branch the screens open on: the switcher's choice when it is still allowed, else the person's home branch,
 * else their only branch. `null` means all the branches they may see.
 */
export function chooseBranch(
  cookie: string | null | undefined,
  access: BranchAccess,
  locationIds: readonly string[],
): string | null {
  const allowed = locationIds.filter((id) => canSeeLocation(access, id));
  if (cookie && cookie !== ALL_BRANCHES && allowed.includes(cookie)) return cookie;
  if (cookie === ALL_BRANCHES) return allowed.length === 1 ? allowed[0] : null;
  if (access.home && allowed.includes(access.home)) return access.home;
  return allowed.length === 1 ? allowed[0] : null;
}

/**
 * Location ids a service-role query must keep to, or `null` for no filter (all branches, unrestricted person).
 * Rows with no branch are always included by the caller (`location_id is null`).
 */
export function branchFilterIds(access: BranchAccess, chosen: string | null): string[] | null {
  if (chosen) return canSeeLocation(access, chosen) ? [chosen] : [];
  return access.scope === "all" ? null : [...access.ids];
}

/** PostgREST `or` filter for a list query: the allowed branches plus rows without one. */
export function branchOrFilter(ids: readonly string[], column = "location_id"): string {
  const safe = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  return safe.length ? `${column}.in.(${safe.join(",")}),${column}.is.null` : `${column}.is.null`;
}
