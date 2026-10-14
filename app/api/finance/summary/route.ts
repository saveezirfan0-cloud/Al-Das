import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { toCsv } from "@/lib/csv";
import { SUMMARY_COLUMNS, currentMonth, monthParam, monthsAgo } from "@/lib/finance/summary";
import { renderSummaryDocument } from "@/lib/finance/report-documents-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/finance/summary?from=yyyy-mm&to=yyyy-mm&branch=P&format=csv|xlsx|pdf → the monthly summary. Requires
 * finance.view. CSV (default) is the plain rows; Excel and PDF (Phase G) add totals, the comparison with the period before
 * and the Provisional / Final label from the CEO month lock. Audited and logged as an export.
 */
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
  const format = url.searchParams.get("format");

  if (format === "xlsx" || format === "pdf") {
    const range = from <= to ? { from, to } : { from: to, to: from };
    const admin = createAdminClient(); // service role AFTER the permission check
    try {
      const doc = await renderSummaryDocument(
        admin,
        { id: member.orgId, name: member.org.name },
        { ...range, branch: branch || null },
        format,
      );
      await recordAudit(admin, {
        orgId: member.orgId,
        userId: member.userId,
        action: "finance.summary.exported",
        entity: "v_fin_monthly_measures",
        diff: { ...range, branch: branch || null, rows: doc.rows, format },
      });
      await recordExport(admin, member, { dataset: "finance:summary", rows: doc.rows, format });
      return new NextResponse(new Uint8Array(doc.body), {
        headers: {
          "Content-Type": doc.contentType,
          "Content-Disposition": `attachment; filename="finance-summary-${range.from}-${range.to}.${format}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return NextResponse.json({ error: "query failed" }, { status: 500 });
    }
  }

  let q = (await createClient())
    .from("v_fin_monthly_measures")
    .select(
      "month, branch_code, generated, claimed, accepted, paid_allocated, remitted, rejected, outstanding, self_pay_collected",
    )
    .eq("org_id", member.orgId)
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
    entity: "v_fin_monthly_measures",
    diff: { from, to, branch: branch || null, rows: data?.length ?? 0 },
  });
  await recordExport(createAdminClient(), member, {
    dataset: "finance:summary",
    rows: data?.length ?? 0,
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
