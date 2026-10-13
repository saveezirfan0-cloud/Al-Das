import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthOf } from "@/lib/finance/flash";
import { loadFlashReport } from "@/lib/finance/flash-server";
import { flashWorkbook } from "@/lib/finance/flash-xlsx";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/flash?date=yyyy-mm-dd -> the flash report workbook (daily summary, month to date, doctors, daily
 * sales). Requires finance.flash.view. Aggregates and doctor names only, no patient data. Written to the access log and
 * the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.flash.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const raw = new URL(req.url).searchParams.get("date") ?? "";
  const today = todayIn(member.org.timezone);
  const day = monthOf(raw) && raw <= today ? raw : today;

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const report = await loadFlashReport(admin, member.orgId, day);
    const body = await flashWorkbook({
      org: member.org.name,
      day,
      daily: report.daily,
      monthToDate: report.monthToDate,
      grid: report.grid,
      previousGrid: report.previousGrid,
      comparison: report.comparison,
      topDoctors: report.topDoctors,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.flash.exported",
      entity: "fin_invoices",
      diff: { day },
    });
    await recordExport(admin, member, {
      dataset: "finance:flash",
      rows: report.grid.days.length,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="flash-report-${day}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
