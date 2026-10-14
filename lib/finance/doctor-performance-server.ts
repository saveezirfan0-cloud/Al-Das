import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { branchView } from "@/lib/branches/server";
import {
  allowedBranchCodes,
  buildDoctorPerformance,
  parseDoctorPerformanceInputs,
  type DoctorPerformance,
} from "@/lib/finance/doctor-performance";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads the doctor performance report (Phase 23B) from the Unite collection report rows. Service role only, so every
 * caller must have checked finance.revenue.view first. Branch-bound (Phase B): the rows are kept to the finance branch
 * codes of the branches the member may see (and the branch switcher's choice); rows with no branch stay visible.
 */

export type PerfScope = {
  /** Finance branch codes the member may see; null = every branch. */
  allowed: string[] | null;
  /** The branch filter's options: the org's finance branches within `allowed`. */
  branches: { code: string; name: string }[];
};

export async function loadPerfScope(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId" | "branchScope" | "branchIds" | "homeLocationId">,
): Promise<PerfScope> {
  const [{ data: locations, error }, { data: branches }] = await Promise.all([
    admin
      .from("locations")
      .select("id, branch_code, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", member.orgId).order("code"),
  ]);
  if (error) throw new Error("Could not load the branches.");
  const locs = locations ?? [];
  const view = await branchView(
    member,
    locs.filter((l) => l.active).map((l) => l.id),
  );
  const allowed = allowedBranchCodes(view.filterIds, locs);
  return {
    allowed,
    branches: (branches ?? [])
      .filter((b) => allowed === null || allowed.includes(b.code))
      .map((b) => ({ code: b.code, name: b.name ?? b.code })),
  };
}

/** The latest month (yyyy-mm-01) with current report rows the member may see, or null when there are none. */
export async function latestReportMonth(
  admin: AdminClient,
  orgId: string,
  allowed: string[] | null,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fin_report_latest_month", {
    p_org_id: orgId,
    p_branches: allowed ?? undefined,
  });
  if (error) throw new Error("Could not read the Unite report months.");
  return typeof data === "string" && data ? data.slice(0, 10) : null;
}

export async function loadDoctorPerformance(
  admin: AdminClient,
  orgId: string,
  opts: { month: string; branch: string | null; allowed: string[] | null },
): Promise<DoctorPerformance> {
  const { data, error } = await admin.rpc("fin_doctor_performance_inputs", {
    p_org_id: orgId,
    p_month: opts.month,
    p_branch: opts.branch ?? undefined,
    p_branches: opts.allowed ?? undefined,
  });
  if (error) throw new Error("Could not load the doctor performance figures.");
  return buildDoctorPerformance(parseDoctorPerformanceInputs(data));
}

/**
 * The latest month's report for a dashboard (same branch scoping as the page), or null when there is no report data.
 * The caller checks finance.revenue.view first.
 */
export async function loadLatestPerformance(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId" | "branchScope" | "branchIds" | "homeLocationId">,
): Promise<DoctorPerformance | null> {
  const scope = await loadPerfScope(admin, member);
  const month = await latestReportMonth(admin, member.orgId, scope.allowed);
  if (!month) return null;
  const report = await loadDoctorPerformance(admin, member.orgId, {
    month,
    branch: null,
    allowed: scope.allowed,
  });
  return report.hasData ? report : null;
}
