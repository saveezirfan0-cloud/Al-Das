import "server-only";

import {
  buildContribution,
  parseContributionInputs,
  type ContributionReport,
} from "@/lib/finance/contribution";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads the contribution report (M2A). Service role only, so every caller must have checked finance.profit.view first
 * and passes `canSeePay` = can(member, 'finance.costs.compensation'); the pure rules then remove individual pay from
 * the result. Branch scoping is 23B's (loadPerfScope / latestReportMonth in doctor-performance-server.ts).
 */
export async function loadContribution(
  admin: AdminClient,
  orgId: string,
  opts: {
    month: string;
    branch: string | null;
    allowed: string[] | null;
    canSeePay: boolean;
    branchNames?: Readonly<Record<string, string>>;
  },
): Promise<ContributionReport> {
  const { data, error } = await admin.rpc("fin_contribution_inputs", {
    p_org_id: orgId,
    p_month: opts.month,
    p_branch: opts.branch ?? undefined,
    p_branches: opts.allowed ?? undefined,
  });
  if (error) throw new Error("Could not load the contribution figures.");
  return buildContribution(parseContributionInputs(data), {
    canSeePay: opts.canSeePay,
    wholeOrg: opts.allowed === null && opts.branch === null,
    branchNames: opts.branchNames,
  });
}
