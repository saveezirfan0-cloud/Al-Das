import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { voucherCertificatePdf } from "@/lib/finance/voucher-certificate";
import { VOUCHER_READ_PERMS } from "@/lib/finance/vouchers";
import {
  certificateFrom,
  loadVoucherDetail,
  loadVoucherScope,
} from "@/lib/finance/vouchers-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/finance/vouchers/<id>/certificate -> the approval certificate PDF, rendered from the stored voucher and its
 * append-only trail (people, times, remarks, the content hash each step was bound to; attachments by kind and sha256).
 * Needs a payables or voucher permission, and the voucher must be one the person may read (loadVoucherScope). Audited and written to the access log as an export.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, VOUCHER_READ_PERMS))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadVoucherScope(admin, member);
  const detail = scope ? await loadVoucherDetail(admin, member.orgId, id, scope) : null;
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
  const pdf = await voucherCertificatePdf(
    certificateFrom(detail, { name: member.org.name, timezone: member.org.timezone }),
  );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.voucher.certificate_downloaded",
    entity: "fin_payment_vouchers",
    entityId: id,
    diff: { voucher_no: detail.voucher.voucher_no, status: detail.voucher.status },
  });
  await recordExport(admin, member, {
    dataset: "finance:voucher-certificate",
    rows: 1,
    format: "pdf",
  });
  const final = detail.voucher.status === "approved" || detail.voucher.status === "paid";
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${detail.voucher.voucher_no}-certificate${final ? "" : "-not-final"}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
