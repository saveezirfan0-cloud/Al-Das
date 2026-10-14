import "server-only";

import {
  buildCollections,
  parseCollectionsInputs,
  type Collections,
} from "@/lib/finance/collections";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads collections and data quality (Phase 23D) from the Unite collection report rows. Service role only, so every
 * caller must have checked finance.revenue.view first. Branch scope is the doctor performance page's
 * (`loadPerfScope()` in doctor-performance-server.ts): pass its `allowed` codes and the page's chosen branch.
 */
export async function loadCollections(
  admin: AdminClient,
  orgId: string,
  opts: { month: string; branch: string | null; allowed: string[] | null },
): Promise<Collections> {
  const { data, error } = await admin.rpc("fin_collections_inputs", {
    p_org_id: orgId,
    p_month: opts.month,
    p_branch: opts.branch ?? undefined,
    p_branches: opts.allowed ?? undefined,
  });
  if (error) throw new Error("Could not load the collections figures.");
  return buildCollections(parseCollectionsInputs(data));
}
