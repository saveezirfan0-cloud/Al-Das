import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { loadCollections } from "@/lib/finance/collections-server";
import { collectionsWorkbook } from "@/lib/finance/collections-xlsx";
import { chosenBranch, monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/collections?month=yyyy-mm&branch=CODE -> the collections and data quality workbook (Daily,
 * Branches, Doctors, Data quality, Definitions). Requires finance.revenue.view and keeps to the member's branches.
 * Aggregates, doctor names and unmapped clinic names only, no patient data. Written to the access log and the audit
 * trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.revenue.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const scope = await loadPerfScope(admin, member);
    const branch = chosenBranch(sp.get("branch"), scope.allowed);
    const month =
      monthParam(sp.get("month")) ??
      (await latestReportMonth(admin, member.orgId, scope.allowed)) ??
      `${todayIn(member.org.timezone).slice(0, 7)}-01`; // same default as the page
    const report = await loadCollections(admin, member.orgId, {
      month,
      branch,
      allowed: scope.allowed,
    });
    const branchNames = Object.fromEntries(scope.branches.map((b) => [b.code, b.name]));
    const branchLabel = branch
      ? (branchNames[branch] ?? branch)
      : scope.allowed === null
        ? "All branches"
        : "All your branches";
    const body = await collectionsWorkbook({
      org: member.org.name,
      report,
      branchLabel,
      branchNames,
      builtAt: new Date().toISOString(),
    });
    const rows = report.total.rows;
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.collections.exported",
      entity: "fin_report_visits",
      diff: { month: month.slice(0, 7), branch: branch ?? "all", rows },
    });
    await recordExport(admin, member, {
      dataset: "finance:collections",
      rows,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="collections-${month.slice(0, 7)}${branch ? `-${branch}` : ""}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
