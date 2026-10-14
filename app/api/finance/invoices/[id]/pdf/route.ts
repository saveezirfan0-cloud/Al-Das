import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { internalInvoicePdf } from "@/lib/finance/invoice-pdf";
import { loadInvoicePdfData } from "@/lib/finance/invoice-server";
import { recordAccess, recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/finance/invoices/<id>/pdf -> the internal copy of a Unite invoice ("Internal copy - not a tax invoice"). Needs
 * finance.invoices.view; the insurer split and payer names need finance.claims.view too (as on the page). The patient is
 * the Unite PIN only. Logged as a download of the invoice and as an export, and audited.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.invoices.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const data = await loadInvoicePdfData(admin, member.orgId, id, {
      claims: can(member, "finance.claims.view"),
    });
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
    const pdf = await internalInvoicePdf(data, {
      orgName: member.org.name,
      builtAt: new Date().toISOString(),
    });
    await recordAccess(admin, member, {
      entity: "finance_invoice",
      entityId: id,
      action: "download",
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.invoice.pdf_downloaded",
      entity: "fin_invoices",
      entityId: id,
      diff: { version: data.version, internal_copy: true },
    });
    await recordExport(admin, member, { dataset: "finance:invoice", rows: 1, format: "pdf" });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${data.number.replace(/[^A-Za-z0-9-]/g, "_")}-internal.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
