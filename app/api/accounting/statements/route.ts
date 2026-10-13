import { NextResponse } from "next/server";

import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import {
  customerBlock,
  loadSeller,
  loadStatement,
  sellerBlock,
} from "@/lib/accounting/receivables-server";
import { statementPdf } from "@/lib/accounting/sales-pdf";
import { statementWorkbook } from "@/lib/accounting/statement-xlsx";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/accounting/statements?customer=<id>&from&to&format=pdf|xlsx -> a customer's statement of account. Needs a
 * receivables read key. Business customers only (no patient data). Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, RECEIVABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const customerId = sp.get("customer") ?? "";
  const from = (sp.get("from") ?? "").slice(0, 10);
  const to = (sp.get("to") ?? "").slice(0, 10);
  const format = sp.get("format") === "xlsx" ? "xlsx" : "pdf";
  if (
    !UUID.test(customerId) ||
    !DATE.test(from) ||
    !DATE.test(to) ||
    Number.isNaN(Date.parse(from)) ||
    Number.isNaN(Date.parse(to)) ||
    from > to
  )
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const s = await loadStatement(admin, member.orgId, customerId, from, to);
    if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
    const seller = await loadSeller(admin, member.orgId, null);
    const input = {
      seller: sellerBlock(seller),
      customer: customerBlock(s.customer),
      from,
      to,
      opening: s.opening,
      rows: s.rows,
      closing: s.closing,
      paymentInstructions: seller.paymentInstructions,
      builtAt: new Date().toISOString(),
    };
    const body = format === "xlsx" ? await statementWorkbook(input) : await statementPdf(input);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.statement.exported",
      entity: "acc_customers",
      entityId: customerId,
      diff: { from, to, format, rows: s.rows.length },
    });
    await recordExport(admin, member, {
      dataset: "accounting:customer_statement",
      rows: s.rows.length,
      format,
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type":
          format === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/pdf",
        "Content-Disposition": `attachment; filename="statement-${from}-${to}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
