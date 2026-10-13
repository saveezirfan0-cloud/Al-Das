import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import {
  billingMixCsv,
  parseBillingMix,
  parseTrend,
  readAnalyticsFilters,
  trendCsv,
} from "@/lib/finance/billing-mix";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/analytics?kind=mix|trend&from=yyyy-mm-dd&to=yyyy-mm-dd&branch=P&grain=month|week -> text/csv.
 * Requires finance.revenue.view. Aggregates only (no patient data). The export is written to the access log and audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.revenue.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "trend" ? "trend" : "mix";
  const f = readAnalyticsFilters((k) => url.searchParams.get(k), todayIn(member.org.timezone));

  const admin = createAdminClient();
  try {
    let csv: string;
    let rows: number;
    if (kind === "mix") {
      const { data, error } = await admin.rpc("fin_billing_mix", {
        p_org_id: member.orgId,
        p_from: f.from,
        p_to: f.to,
        p_branch: f.branch ?? undefined,
      });
      if (error) throw new Error("query failed");
      const mix = parseBillingMix(data);
      csv = billingMixCsv(mix);
      rows = mix.rows.length;
    } else {
      const { data, error } = await admin.rpc("fin_revenue_trend", {
        p_org_id: member.orgId,
        p_from: f.from,
        p_to: f.to,
        p_grain: f.grain,
        p_branch: f.branch ?? undefined,
      });
      if (error) throw new Error("query failed");
      const trend = parseTrend(data);
      csv = trendCsv(trend);
      rows = trend.rows.length;
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.analytics.exported",
      entity: "fin_invoices",
      diff: { kind, from: f.from, to: f.to, branch: f.branch, grain: f.grain, rows },
    });
    await recordExport(admin, member, { dataset: `finance:analytics:${kind}`, rows });
    const name = kind === "mix" ? "billing-mix" : `revenue-by-${f.grain}`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-${f.from}-${f.to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
