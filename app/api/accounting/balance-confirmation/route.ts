import { NextResponse } from "next/server";

import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import {
  customerBlock,
  loadCustomer,
  loadOpenItems,
  loadSeller,
  sellerBlock,
} from "@/lib/accounting/receivables-server";
import { balanceConfirmationPdf } from "@/lib/accounting/sales-pdf";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/accounting/balance-confirmation?customer=<id>&as_of=yyyy-mm-dd -> the balance-confirmation letter for the
 * auditors (the balance per Pulse's receivables and its open items). Needs a receivables read key. Audited and logged.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, RECEIVABLES_READ))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const customerId = sp.get("customer") ?? "";
  const asOf = (sp.get("as_of") ?? "").slice(0, 10);
  if (!UUID.test(customerId) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf)))
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const customer = await loadCustomer(admin, member.orgId, customerId);
    if (!customer) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [items, seller] = await Promise.all([
      loadOpenItems(admin, member.orgId, customerId, asOf),
      loadSeller(admin, member.orgId, null),
    ]);
    const balance =
      Math.round(
        (items.invoices.reduce((s, i) => s + i.open, 0) -
          items.on_account.reduce((s, r) => s + r.unallocated, 0)) *
          100,
      ) / 100;
    const pdf = await balanceConfirmationPdf({
      seller: sellerBlock(seller),
      customer: customerBlock(customer),
      asOf,
      balance,
      invoices: items.invoices.map((i) => ({
        number: i.number,
        date: i.invoice_date,
        due: i.due_date,
        open: i.open,
      })),
      onAccount: items.on_account.map((r) => ({
        number: r.number,
        date: r.receipt_date,
        amount: r.unallocated,
      })),
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.balance_confirmation.exported",
      entity: "acc_customers",
      entityId: customerId,
      diff: { as_of: asOf, balance },
    });
    await recordExport(admin, member, {
      dataset: "accounting:balance_confirmation",
      rows: items.invoices.length + items.on_account.length,
      format: "pdf",
    });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="balance-confirmation-${asOf}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
