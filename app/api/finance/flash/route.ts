import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import { monthOf } from "@/lib/finance/flash";
import { renderFlashDocument } from "@/lib/finance/report-documents-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/flash?date=yyyy-mm-dd (default yesterday)&format=xlsx|pdf (default xlsx) -> the flash report: the
 * workbook (daily summary, month to date, doctors, daily sales) or the PDF (Phase G: the day and month to date). Requires
 * finance.flash.view. Aggregates and doctor names only, no patient data; labelled Provisional until the month is locked.
 * Written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.flash.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const raw = params.get("date") ?? "";
  const format = params.get("format") === "pdf" ? "pdf" : "xlsx";
  const today = todayIn(member.org.timezone);
  const day = monthOf(raw) && raw <= today ? raw : (addDays(today, -1) ?? today); // same default as the page

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const doc = await renderFlashDocument(
      admin,
      { id: member.orgId, name: member.org.name },
      day,
      format,
    );
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.flash.exported",
      entity: "fin_invoices",
      diff: { day, format },
    });
    await recordExport(admin, member, { dataset: "finance:flash", rows: doc.rows, format });
    return new NextResponse(new Uint8Array(doc.body), {
      headers: {
        "Content-Type": doc.contentType,
        "Content-Disposition": `attachment; filename="flash-report-${day}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
