import "server-only";

import { canSeeLocation, parseBranchScope, type BranchScope } from "@/lib/branches/access";
import { parseEnquiryScope, type EnquiryViewer } from "@/lib/enquiries/scope";
import type { AdminClient } from "@/lib/supabase/admin";

type MemberRef = {
  userId: string;
  orgId: string;
  enquiryScope?: string | null;
  /** Phase B branch access, as the session loads it (lib/auth/session.ts). */
  branchScope?: BranchScope;
  branchIds?: readonly string[];
};

/**
 * The viewer for service-role enquiry reads (Phase 20c, branches Phase B). Uses what the session already loaded; when
 * it did not (older callers, tests), reads the membership, and an unreadable enquiry scope counts as "own" (fail
 * closed). A membership that cannot be read at all keeps to rows with no branch.
 */
export async function enquiryViewer(admin: AdminClient, member: MemberRef): Promise<EnquiryViewer> {
  const known = member.enquiryScope !== undefined && member.enquiryScope !== null;
  if (known && member.branchScope !== undefined)
    return {
      userId: member.userId,
      scope: parseEnquiryScope(member.enquiryScope),
      branchScope: member.branchScope,
      branchIds: member.branchIds ?? [],
    };
  const { data } = await admin
    .from("memberships")
    .select("enquiry_scope, branch_scope, membership_locations(location_id)")
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId)
    .maybeSingle();
  return {
    userId: member.userId,
    scope: parseEnquiryScope(known ? member.enquiryScope : data?.enquiry_scope),
    branchScope: data ? parseBranchScope(data.branch_scope) : "selected",
    branchIds: (data?.membership_locations ?? []).map((l) => l.location_id),
  };
}

/**
 * The subset of `ids` this viewer may see (same rules as RLS: app.enquiry_visible_to and app.location_visible_to).
 * Order preserved.
 */
export async function visibleEnquiryIds(
  admin: AdminClient,
  orgId: string,
  viewer: EnquiryViewer,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return ids;
  let out = ids;
  if (viewer.scope !== "all") {
    const { data, error } = await admin.rpc("enquiry_ids_visible_to", {
      p_org_id: orgId,
      p_user_id: viewer.userId,
      p_ids: ids,
    });
    if (error) throw new Error(`enquiry_ids_visible_to failed (${error.code ?? "unknown"})`);
    const ok = new Set((data ?? []) as unknown as string[]);
    out = out.filter((id) => ok.has(id));
  }
  if (viewer.branchScope === "selected" && out.length > 0) {
    const access = { scope: "selected" as const, ids: viewer.branchIds ?? [], home: null };
    const ok = new Set<string>();
    // In chunks: a long id list would make an over-long request URL.
    for (let i = 0; i < out.length; i += 200) {
      const { data, error } = await admin
        .from("enquiries")
        .select("id, location_id")
        .eq("org_id", orgId)
        .in("id", out.slice(i, i + 200));
      if (error) throw new Error(`enquiry branch check failed (${error.code ?? "unknown"})`);
      for (const r of data ?? []) if (canSeeLocation(access, r.location_id)) ok.add(r.id);
    }
    out = out.filter((id) => ok.has(id));
  }
  return out;
}

export async function canSeeEnquiry(
  admin: AdminClient,
  orgId: string,
  viewer: EnquiryViewer,
  id: string,
): Promise<boolean> {
  return (await visibleEnquiryIds(admin, orgId, viewer, [id])).length === 1;
}
