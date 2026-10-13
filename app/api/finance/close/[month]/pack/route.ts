import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { closePackXlsx } from "@/lib/finance/close-xlsx";
import { loadCloseByMonth, MONTH_RE } from "@/lib/finance/close-server";
import { closePackPdfFile } from "@/lib/finance/signed-pdfs-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

// pdf-lib, @signpdf and node-forge need Node (not the Edge runtime).
export const runtime = "nodejs";

/**
 * GET /api/finance/close/<yyyy-mm>/pack?format=xlsx|pdf. Needs one of the close permissions. Always rendered from the stored
 * snapshot (the frozen pack), so a pack downloaded after the month is locked is the pack that was signed. Written to the
 * access log and the audit trail.
 */
export async function GET(req: Request, ctx: { params: Promise<{ month: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (
    !canAny(member, [
      "finance.close.view",
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.close.signoff.ceo",
    ])
  )
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { month } = await ctx.params;
  if (!MONTH_RE.test(month)) return NextResponse.json({ error: "bad month" }, { status: 400 });
  const format = new URL(req.url).searchParams.get("format") === "pdf" ? "pdf" : "xlsx";

  const admin = createAdminClient();
  const close = await loadCloseByMonth(admin, member.orgId, month);
  if (!close?.pack) return NextResponse.json({ error: "no pack for that month" }, { status: 404 });
  // Phase 22C: the PDF lists the personal signatures; a locked month's PDF is sealed (when the seal is on) and stored,
  // so every download of it returns the same signed bytes.
  const pdf =
    format === "pdf"
      ? await closePackPdfFile(
          admin,
          {
            orgId: member.orgId,
            orgName: member.org.name,
            timezone: member.org.timezone,
            userId: member.userId,
          },
          close,
        )
      : null;
  const body = pdf ? pdf.pdf : await closePackXlsx(close.pack, close.sign);

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.downloaded",
    entity: "fin_period_closes",
    entityId: close.id,
    diff: { month, format, status: close.status, sealed: pdf?.sealed ?? false },
  });
  await recordExport(admin, member, {
    dataset: "finance:close-pack",
    rows: close.pack.by_branch.length,
    format,
  });
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type":
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="month-end-close-${month}${close.status === "locked" ? "" : "-draft"}.${format}"`,
      "Cache-Control": "no-store",
    },
  });
}
