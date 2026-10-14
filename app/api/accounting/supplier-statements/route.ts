import { NextResponse } from "next/server";

import { PAYABLES_READ } from "@/lib/accounting/nav";
import { loadSupplierStatement } from "@/lib/accounting/payables-server";
import { supplierStatementWorkbook } from "@/lib/accounting/payables-xlsx";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { xlsxResponseInit } from "@/lib/export/table-xlsx";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/accounting/supplier-statements?supplier=<id>&from&to -> one supplier's statement as Excel. Needs a payables read
 * key (PAYABLES_READ). Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, PAYABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const supplierId = sp.get("supplier") ?? "";
  const from = (sp.get("from") ?? "").slice(0, 10);
  const to = (sp.get("to") ?? "").slice(0, 10);
  const valid = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!UUID.test(supplierId) || !valid(from) || !valid(to) || from > to)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const s = await loadSupplierStatement(admin, member.orgId, supplierId, from, to);
    if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = await supplierStatementWorkbook(s, {
      org: member.org.name,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.supplier_statement.exported",
      entity: "fin_suppliers",
      entityId: supplierId,
      diff: { from, to, rows: s.rows.length },
    });
    await recordExport(admin, member, {
      dataset: "accounting:supplier_statement",
      rows: s.rows.length,
      format: "xlsx",
    });
    return new NextResponse(
      new Uint8Array(body),
      xlsxResponseInit(`supplier-statement-${from}-${to}`),
    );
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
