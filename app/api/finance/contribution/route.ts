import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { loadContribution } from "@/lib/finance/contribution-server";
import { contributionWorkbook } from "@/lib/finance/contribution-xlsx";
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/contribution?month=yyyy-mm&branch=CODE -> the contribution workbook (Contribution, Definitions).
 * Requires finance.profit.view and keeps to the member's branches; without finance.costs.compensation the file has no
 * pay column and no individual doctor's contribution (the same pure result as the page). Amounts, doctor names and
 * DHA ids only. Written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.profit.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const canSeePay = can(member, "finance.costs.compensation");

  const sp = new URL(req.url).searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const scope = await loadPerfScope(admin, member);
    const branch = chosenBranch(sp.get("branch"), scope.allowed);
    const month =
      monthParam(sp.get("month")) ??
      (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
      `${todayIn(member.org.timezone).slice(0, 7)}-01`; // same default as the page
    const report = await loadContribution(admin, member.orgId, {
      month,
      branch,
      allowed: scope.allowed,
      canSeePay,
      branchNames: Object.fromEntries(scope.branches.map((b) => [b.code, b.name])),
    });
    const branchLabel = branch
      ? (scope.branches.find((b) => b.code === branch)?.name ?? branch)
      : scope.allowed === null
        ? "All branches"
        : "All your branches";
    const body = await contributionWorkbook({
      org: member.org.name,
      report,
      branchLabel,
      builtAt: new Date().toISOString(),
    });
    const rows = report.clinics.reduce(
      (a, c) => a + c.departments.reduce((b, d) => b + d.doctors.length, 0),
      0,
    );
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.contribution.exported",
      entity: "fin_report_visits",
      diff: {
        month: month.slice(0, 7),
        branch: branch ?? "all",
        rows,
        with_pay: canSeePay,
        provisional: report.provisional,
      },
    });
    await recordExport(admin, member, { dataset: "finance:contribution", rows, format: "xlsx" });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="contribution-${month.slice(0, 7)}${branch ? `-${branch}` : ""}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
