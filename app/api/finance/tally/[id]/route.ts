import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/finance/tally/<export id> -> the stored TallyPrime import file, byte for byte as recorded (its sha256 is checked
 * against the recorded checksum before it is served). Needs finance.tally.export. Audited and written to the access log.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.tally.export"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  const { data } = await admin
    .from("fin_tally_exports")
    .select("id, xml, checksum, voucher_count, invoice_count, created_at")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (createHash("sha256").update(data.xml, "utf8").digest("hex") !== data.checksum)
    return NextResponse.json(
      { error: "the stored file does not match its checksum" },
      { status: 409 },
    );

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.tally.downloaded",
    entity: "fin_tally_exports",
    entityId: data.id,
    diff: { vouchers: data.voucher_count, invoices: data.invoice_count },
  });
  await recordExport(admin, member, {
    dataset: "finance:tally-xml",
    rows: data.voucher_count + data.invoice_count,
    format: "xml",
  });
  return new NextResponse(data.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="tally-import-${data.created_at.slice(0, 10)}-${data.id.slice(0, 8)}.xml"`,
      "Cache-Control": "no-store",
    },
  });
}
