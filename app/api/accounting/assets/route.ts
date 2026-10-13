import { NextResponse } from "next/server";

import { loadAssetReport } from "@/lib/accounting/assets/server";
import { assetWorkbook } from "@/lib/accounting/assets/xlsx";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/accounting/assets?asOf=yyyy-mm-dd -> the fixed asset register at that date, the 12-month depreciation
 * forecast and the schedule status as one workbook (Phase 22H). Requires accounting.assets.manage or
 * accounting.reports.view. Codes, descriptions, dates and amounts only. Written to the audit trail and the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, ["accounting.assets.manage", "accounting.reports.view"]))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const raw = (new URL(req.url).searchParams.get("asOf") ?? "").slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const asOf =
    /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : today;

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const report = await loadAssetReport(admin, member.orgId, asOf, today);
    const body = await assetWorkbook({
      org: member.org.name,
      asOf,
      register: report.register,
      forecast: report.forecast,
      schedules: report.schedules,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.assets.exported",
      entity: "acc_assets",
      diff: { as_of: asOf },
    });
    await recordExport(admin, member, {
      dataset: "accounting:fixed_assets",
      rows: report.register.lines.length + report.schedules.length,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="fixed-assets-${asOf}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
