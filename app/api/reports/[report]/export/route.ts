import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { reportToCsv, reportFilename } from "@/lib/reports/export";
import { reportFiltersSchema } from "@/lib/reports/filters";
import { getReport, reportStatus } from "@/lib/reports/registry";
import { availableSources, reportContext } from "@/lib/reports/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/reports/<key>/export  { ...ReportFilters }  →  text/csv
 * Same auth sequence as the contacts export: 401 → 403 → validate → run → audit. The filters are the
 * ones on screen, so the file matches the page. The audit entry records the report and period only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ report: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!can(member, "reports.view") || !can(member, "reports.export")) {
    return NextResponse.json({ error: "You don't have permission to export reports." }, { status: 403 });
  }

  const def = getReport((await params).report);
  if (!def) return NextResponse.json({ error: "Unknown report." }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = reportFiltersSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid filters." }, { status: 400 });
  }

  const admin = createAdminClient();
  if (reportStatus(def, await availableSources(admin)) !== "live") {
    return NextResponse.json({ error: "This report has no data yet." }, { status: 409 });
  }

  const ctx = reportContext(member, parsed.data);
  const result = await def.run!(ctx);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "report.exported",
    entity: "report",
    entityId: null,
    diff: { report: def.key, from: ctx.range.fromDay, to: ctx.range.toDay, rows: result.table.rows.length },
  });

  return new NextResponse(reportToCsv(result), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reportFilename(def.key, ctx.range.fromDay, ctx.range.toDay)}"`,
      "Cache-Control": "no-store",
    },
  });
}
