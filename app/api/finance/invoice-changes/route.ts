import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import {
  CHANGE_KINDS,
  changesCsv,
  defaultPeriod,
  periodProblem,
  reviewOrder,
  type ChangeKind,
} from "@/lib/finance/invoice-changes";
import { loadChanges } from "@/lib/finance/invoice-changes-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/invoice-changes?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=discount -> text/csv: the Unite invoice changes in the
 * period with their review status. Requires finance.changes.view. Invoice numbers, codes, amounts and decisions only; no
 * patient data. The export is written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.changes.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const def = defaultPeriod(todayIn(member.org.timezone));
  const from = (url.searchParams.get("from") ?? "").slice(0, 10) || def.from;
  const to = (url.searchParams.get("to") ?? "").slice(0, 10) || def.to;
  if (periodProblem(from, to)) return NextResponse.json({ error: "bad period" }, { status: 400 });
  const k = url.searchParams.get("kind") ?? "";
  const kind = (CHANGE_KINDS as readonly string[]).includes(k) ? (k as ChangeKind) : null;

  const admin = createAdminClient(); // service role AFTER the permission check
  const reg = await loadChanges(admin, member.orgId, from, to).catch(() => null);
  if (!reg) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const rows = reviewOrder(
    reg.events.filter((e) => kind === null || e.kind === kind),
    reg,
  );
  const csv = changesCsv(reg, rows);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.invoice_changes.exported",
    entity: "fin_invoices",
    diff: { from, to, kind, rows: rows.length },
  });
  await recordExport(admin, member, { dataset: "finance:invoice-changes", rows: rows.length });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoice-changes-${from}-to-${to}${kind ? `-${kind}` : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
