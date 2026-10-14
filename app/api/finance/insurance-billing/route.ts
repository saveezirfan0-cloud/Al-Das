import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { loadInsuranceBilling } from "@/lib/finance/insurance-billing-server";
import { insuranceBillingWorkbook } from "@/lib/finance/insurance-billing-xlsx";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/insurance-billing?month=yyyy-mm&branch=CODE -> the insurance billed vs claimed workbook. Requires
 * finance.claims.view and keeps to the member's branches. Invoice numbers, amounts, payer ids and doctor names only,
 * no patient data. Written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.claims.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const today = todayIn(member.org.timezone);
    const scope = await loadPerfScope(admin, member);
    const branch = chosenBranch(sp.get("branch"), scope.allowed);
    const month =
      monthParam(sp.get("month")) ??
      (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
      `${today.slice(0, 7)}-01`; // same default as the page
    const report = await loadInsuranceBilling(admin, member.orgId, {
      month,
      branch,
      allowed: scope.allowed,
      asOf: today,
    });
    const branchLabel = branch
      ? (scope.branches.find((b) => b.code === branch)?.name ?? branch)
      : scope.allowed === null
        ? "All branches"
        : "All your branches";
    const body = await insuranceBillingWorkbook({
      org: member.org.name,
      report,
      branchLabel,
      builtAt: new Date().toISOString(),
    });
    const rows =
      report.matched.length +
      report.billedNotSubmitted.length +
      report.awaiting.length +
      report.ambiguous.length +
      report.unreported.length;
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.insurance_billing.exported",
      entity: "fin_report_visits",
      diff: { month: month.slice(0, 7), branch: branch ?? "all", rows },
    });
    await recordExport(admin, member, {
      dataset: "finance:insurance-billing",
      rows,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="insurance-billed-vs-claimed-${month.slice(0, 7)}${branch ? `-${branch}` : ""}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
