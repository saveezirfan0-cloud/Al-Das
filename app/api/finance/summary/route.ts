import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { toCsv } from "@/lib/csv";
import { SUMMARY_COLUMNS, currentMonth, monthParam, monthsAgo } from "@/lib/finance/summary";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** GET /api/finance/summary?from=yyyy-mm&to=yyyy-mm&branch=P → text/csv. Requires finance.view. */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const from = monthParam(url.searchParams.get("from") ?? undefined, monthsAgo(11));
  const to = monthParam(url.searchParams.get("to") ?? undefined, currentMonth());
  const branch = (url.searchParams.get("branch") ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();

  let q = (await createClient())
    .from("v_fin_monthly_summary")
    .select(
      "month, branch_code, generated, claimed, remitted, rejected, outstanding, self_pay_collected",
    )
    .gte("month", `${from}-01`)
    .lte("month", `${to}-01`)
    .order("month", { ascending: false })
    .order("branch_code");
  if (branch) q = q.eq("branch_code", branch);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "query failed" }, { status: 500 });

  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.summary.exported",
    entity: "v_fin_monthly_summary",
    diff: { from, to, branch: branch || null, rows: data?.length ?? 0 },
  });

  const csv = toCsv(
    ["Month", "Branch", ...SUMMARY_COLUMNS],
    (data ?? []).map((r) => [
      r.month?.slice(0, 7),
      r.branch_code ?? "unknown",
      ...SUMMARY_COLUMNS.map((c) => r[c]),
    ]),
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="finance-summary-${from}-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
