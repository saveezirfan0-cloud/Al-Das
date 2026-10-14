import "server-only";

import {
  buildInsuranceBilling,
  parseReconInputs,
  type InsuranceBillingRecon,
} from "@/lib/finance/insurance-billing";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads insurance billed vs claimed (Phase 23D-2) for one month. Service role only, so every caller must have checked
 * finance.claims.view first. Branch scope as Phase 23B: pass the member's allowed finance codes (loadPerfScope in
 * doctor-performance-server.ts; null = every branch) and the page's own branch choice.
 */
export async function loadInsuranceBilling(
  admin: AdminClient,
  orgId: string,
  opts: { month: string; branch: string | null; allowed: string[] | null; asOf: string },
): Promise<InsuranceBillingRecon> {
  const { data, error } = await admin.rpc("fin_insurance_billing_recon_inputs", {
    p_org_id: orgId,
    p_month: opts.month,
    p_branch: opts.branch ?? undefined,
    p_branches: opts.allowed ?? undefined,
  });
  if (error) throw new Error("Could not load the insurance billing reconciliation.");
  return buildInsuranceBilling(parseReconInputs(data), opts.asOf);
}
