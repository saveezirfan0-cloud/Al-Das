import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { parseReceivables, receivablesCsv, receivablesMatrix } from "@/lib/finance/followup";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/receivables?branch=P -> text/csv: outstanding insurance amounts and claim counts by payer and age bucket
 * (the candidate ARP report, OQ-95). Requires finance.claims.view. Payer ids and amounts only, no patient data. The export
 * is written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.claims.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const branch =
    (url.searchParams.get("branch") ?? "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase() || null;
  const today = todayIn(member.org.timezone);

  const admin = createAdminClient(); // service role AFTER the permission check
  const { data, error } = await admin.rpc("fin_receivables_by_payer_age", {
    p_org_id: member.orgId,
    p_today: today,
    p_branch: branch ?? undefined,
  });
  if (error) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const r = parseReceivables(data);
  const matrix = receivablesMatrix(r.aggregates, r.bucketDays);
  const csv = receivablesCsv(matrix, today);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.receivables.exported",
    entity: "ins_claim_activities",
    diff: { as_of: today, branch, payers: matrix.payers.length, claims: matrix.totals.claims },
  });
  await recordExport(admin, member, { dataset: "finance:receivables", rows: matrix.payers.length });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="receivables-by-payer-and-age-${today}${branch ? `-${branch}` : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
