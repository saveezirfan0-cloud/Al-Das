import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  asRejectionOrigin,
  type DenialCategory,
  type DenialCodeRow,
  type OwnerRole,
} from "@/lib/finance/denials";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

/**
 * The denial reason-code taxonomy (fin_ref_denial_codes) as the pure rules in lib/finance/denials.ts read it, including
 * the rejection origin and avoidable flag (docs/48). Works with the member's own client (RLS: reference, denials,
 * scorecards or remittance keys) or the service role after can(). Always filtered to one organisation (a person in two
 * organisations must never get the other one's codes).
 */
export async function loadDenialTaxonomy(
  client: SupabaseClient<Database> | AdminClient,
  orgId: string,
): Promise<DenialCodeRow[]> {
  const { data } = await client
    .from("fin_ref_denial_codes")
    .select(
      "code, is_family, description, category, default_owner_role, resubmit_days, appealable, active, origin, avoidable",
    )
    .eq("org_id", orgId);
  return (data ?? []).map((r) => ({
    code: r.code,
    isFamily: r.is_family,
    description: r.description,
    category: r.category as DenialCategory,
    defaultOwnerRole: r.default_owner_role as OwnerRole,
    resubmitDays: r.resubmit_days,
    appealable: r.appealable,
    active: r.active,
    origin: asRejectionOrigin(r.origin),
    avoidable: typeof r.avoidable === "boolean" ? r.avoidable : null,
  }));
}
