import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { buildAccountingExport, validPeriod } from "@/lib/finance/export-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/export/accounting?from=yyyy-mm-dd&to=yyyy-mm-dd -> a journal CSV for an accounting package (one-way: Pulse
 * never reads anything back). Needs finance.export.run. FINAL when every month in the period is locked, otherwise PROVISIONAL.
 * Refuses (422) while any account is unmapped. Logged in fin_accounting_exports, the audit trail and the access log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.export.run"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const bad = validPeriod(from, to);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });

  const admin = createAdminClient();
  let build;
  try {
    build = await buildAccountingExport(admin, member.orgId, from, to);
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
  if (!build.result.ok)
    return NextResponse.json(
      { error: "Some accounts are not mapped yet.", unmapped: build.result.unmapped },
      { status: 422 },
    );
  const r = build.result;

  const { data: row } = await admin
    .from("fin_accounting_exports")
    .insert({
      org_id: member.orgId,
      period_from: from,
      period_to: to,
      status: build.status,
      row_count: r.rowCount,
      debit_total: r.debitTotal,
      credit_total: r.creditTotal,
      checksum: r.checksum,
      exported_by: member.userId,
    })
    .select("id")
    .single();
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.export.accounting",
    entity: "fin_accounting_exports",
    entityId: row?.id ?? null,
    diff: { from, to, status: build.status, rows: r.rowCount },
  });
  await recordExport(admin, member, { dataset: "finance:accounting-journal", rows: r.rowCount });
  return new NextResponse(r.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="journal-${from}-to-${to}-${build.status}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
