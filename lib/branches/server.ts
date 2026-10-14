import "server-only";

import { cookies } from "next/headers";

import type { CurrentMember } from "@/lib/auth/session";
import {
  BRANCH_COOKIE,
  branchFilterIds,
  chooseBranch,
  readBranchAccess,
  type BranchAccess,
} from "@/lib/branches/access";

export type BranchView = {
  access: BranchAccess;
  /** The branch the screens show (switcher choice, else home, else the only one); null = all the member may see. */
  current: string | null;
  /** Ids a service-role query must keep to (plus rows without a branch), or null for no filter. */
  filterIds: string[] | null;
};

/**
 * The member's branch view for a page that already loaded the org's locations. Reads the switcher cookie only; never
 * widens access (lib/branches/access.ts).
 */
export async function branchView(
  member: Pick<CurrentMember, "branchScope" | "branchIds" | "homeLocationId">,
  locationIds: readonly string[],
): Promise<BranchView> {
  const access = readBranchAccess(member);
  const cookie = (await cookies()).get(BRANCH_COOKIE)?.value;
  const current = chooseBranch(cookie, access, locationIds);
  return { access, current, filterIds: branchFilterIds(access, current) };
}
