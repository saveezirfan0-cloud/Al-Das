import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import {
  parseRevenue,
  previousPeriod,
  REVENUE_DIMENSIONS,
  revenueCsv,
  withComparison,
  type RevenueDimension,
} from "@/lib/finance/revenue";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/revenue?dimension=doctor&from=yyyy-mm-dd&to=yyyy-mm-dd&branch=P&compare=1 -> text/csv.
 * Requires finance.revenue.view. Aggregates only (no patient data). The export is written to the access log and audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.revenue.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const date = (k: string) => {
    const v = url.searchParams.get(k) ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const today = todayIn(member.org.timezone);
  const to = date("to") ?? today;
  const from = date("from") ?? addDays(to, -29) ?? to;
  const dimension = (REVENUE_DIMENSIONS as readonly string[]).includes(
    url.searchParams.get("dimension") ?? "",
  )
    ? (url.searchParams.get("dimension") as RevenueDimension)
    : "category";
  const branch =
    (url.searchParams.get("branch") ?? "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase() || null;

  const admin = createAdminClient();
  const get = async (f: string, t: string) => {
    const { data, error } = await admin.rpc("fin_revenue_breakdown", {
      p_org_id: member.orgId,
      p_from: f,
      p_to: t,
      p_dimension: dimension,
      p_branch: branch ?? undefined,
      p_limit: 5000,
    });
    if (error) throw new Error("query failed");
    return parseRevenue(data);
  };
  try {
    const current = await get(from, to);
    const prev = url.searchParams.get("compare") === "1" ? previousPeriod(from, to) : null;
    const previous = prev ? await get(prev.from, prev.to) : null;
    const csv = revenueCsv(withComparison(current, previous), dimension);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.revenue.exported",
      entity: "fin_invoices",
      diff: { dimension, from, to, branch, rows: current.length },
    });
    await recordExport(admin, member, { dataset: "finance:revenue", rows: current.length });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="revenue-by-${dimension}-${from}-${to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
