import { NextResponse } from "next/server";

import { reportPdf, reportWorkbook } from "@/lib/accounting/statements/export";
import {
  parseStatementParams,
  STATEMENT_REPORTS,
  type StatementReport,
} from "@/lib/accounting/statements/params";
import {
  buildStatement,
  REPORT_PERMISSIONS,
  statementContext,
} from "@/lib/accounting/statements/server";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/accounting/reports/<report>?format=xlsx|pdf&<the page's options> -> the statement as Excel or PDF, built from
 * the same data and shaping as the page (Phase 22G). Needs the report's permission (REPORT_PERMISSIONS). Account codes,
 * names, amounts and journal numbers only. Written to the audit trail and the export log.
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { report: raw } = await params;
  if (!(STATEMENT_REPORTS as readonly string[]).includes(raw))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const report = raw as StatementReport;
  if (!canAny(member, REPORT_PERMISSIONS[report]))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const format = sp.get("format") === "pdf" ? "pdf" : "xlsx";
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const ctx = await statementContext(admin, member.orgId, sp.get("entity"), today);
    const p = parseStatementParams(sp, { from: ctx.fy.start, to: today });
    const built = await buildStatement(admin, member, report, { ...p, box: null }, ctx);
    const meta = { org: member.org.name, builtAt: new Date().toISOString() };
    const body =
      format === "pdf" ? await reportPdf(built.doc, meta) : await reportWorkbook(built.doc, meta);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.report.exported",
      entity: "acc_journals",
      diff: { report, format, from: p.from, to: p.to, entity: ctx.entity?.id ?? null },
    });
    await recordExport(admin, member, {
      dataset: `accounting:${report}`,
      rows: built.rows,
      format,
    });
    const name = `${report}-${p.from}-${p.to}.${format}`;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type":
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
