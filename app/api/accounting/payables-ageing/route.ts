import { NextResponse } from "next/server";

import { PAYABLES_READ } from "@/lib/accounting/nav";
import { loadPayablesAgeing } from "@/lib/accounting/payables-server";
import { payablesAgeingWorkbook } from "@/lib/accounting/payables-xlsx";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { xlsxResponseInit } from "@/lib/export/table-xlsx";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/accounting/payables-ageing?as_of=yyyy-mm-dd -> the payables ageing workbook (per supplier and every open
 * invoice). Needs a payables read key (PAYABLES_READ). Supplier names, invoice numbers, dates and amounts only. Audited and
 * written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, PAYABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const raw = (new URL(req.url).searchParams.get("as_of") ?? "").slice(0, 10);
  const asOf = raw ? raw : todayIn(member.org.timezone);
  if (!DATE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)))
    return NextResponse.json({ error: "bad date" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const a = await loadPayablesAgeing(admin, member.orgId, asOf);
    const body = await payablesAgeingWorkbook(a, {
      org: member.org.name,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.payables_ageing.exported",
      entity: "fin_supplier_invoices",
      diff: { as_of: asOf, suppliers: a.rows.length, open_invoices: a.open.length },
    });
    await recordExport(admin, member, {
      dataset: "accounting:payables_ageing",
      rows: a.open.length,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), xlsxResponseInit(`payables-ageing-${asOf}`));
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
