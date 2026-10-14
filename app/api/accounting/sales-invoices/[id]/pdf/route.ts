import { NextResponse } from "next/server";

import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { renderSalesDocument } from "@/lib/accounting/sales-document-server";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/accounting/sales-invoices/<id>/pdf -> the tax invoice or tax credit note PDF of an issued document, rendered from
 * the stored document. Needs a receivables read key. Audited and written to the export log.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, RECEIVABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  const d = await renderSalesDocument(admin, member.orgId, id);
  if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.sales_document.pdf_downloaded",
    entity: "acc_sales_invoices",
    entityId: d.id,
    diff: { number: d.number, kind: d.kind },
  });
  await recordExport(admin, member, { dataset: `accounting:${d.kind}`, rows: 1, format: "pdf" });
  return new NextResponse(new Uint8Array(d.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${d.number.replace(/[^A-Za-z0-9-]/g, "_")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
