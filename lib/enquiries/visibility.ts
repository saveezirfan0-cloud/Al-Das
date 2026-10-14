import "server-only";

import { parseEnquiryScope, type EnquiryViewer } from "@/lib/enquiries/scope";
import type { AdminClient } from "@/lib/supabase/admin";

type MemberRef = { userId: string; orgId: string; enquiryScope?: string | null };

/**
 * The viewer for service-role enquiry reads (Phase 20c). Uses the scope the session already loaded; when it did not
 * (older callers, tests), reads it, and an unreadable value counts as "own" (fail closed).
 */
export async function enquiryViewer(admin: AdminClient, member: MemberRef): Promise<EnquiryViewer> {
  if (member.enquiryScope !== undefined && member.enquiryScope !== null)
    return { userId: member.userId, scope: parseEnquiryScope(member.enquiryScope) };
  const { data } = await admin
    .from("memberships")
    .select("enquiry_scope")
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId)
    .maybeSingle();
  return { userId: member.userId, scope: parseEnquiryScope(data?.enquiry_scope) };
}

/** The subset of `ids` this viewer may see (same rule as RLS: app.enquiry_visible_to). Order preserved. */
export async function visibleEnquiryIds(
  admin: AdminClient,
  orgId: string,
  viewer: EnquiryViewer,
  ids: string[],
): Promise<string[]> {
  if (viewer.scope === "all" || ids.length === 0) return ids;
  const { data, error } = await admin.rpc("enquiry_ids_visible_to", {
    p_org_id: orgId,
    p_user_id: viewer.userId,
    p_ids: ids,
  });
  if (error) throw new Error(`enquiry_ids_visible_to failed (${error.code ?? "unknown"})`);
  const ok = new Set((data ?? []) as unknown as string[]);
  return ids.filter((id) => ok.has(id));
}

export async function canSeeEnquiry(
  admin: AdminClient,
  orgId: string,
  viewer: EnquiryViewer,
  id: string,
): Promise<boolean> {
  return (await visibleEnquiryIds(admin, orgId, viewer, [id])).length === 1;
}
