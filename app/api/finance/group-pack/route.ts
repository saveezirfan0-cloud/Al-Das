import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tablesWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { todayIn } from "@/lib/finance/action-support";
import { lastClosedMonth, MONTH_RE } from "@/lib/finance/close-server";
import { buildGroupPack } from "@/lib/finance/group-pack";
import { GroupPackScopeError, loadGroupPackInput } from "@/lib/finance/group-pack-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/group-pack?month=yyyy-mm -> Al Das's submission for the Bindrai group reporting pack (docs/51):
 * Entity P&L, KPI scorecard, Clinic Branch Source Data, receivables and payables ageing, close checklist, definitions.
 * Requires finance.group_pack.export (the Finance Manager: it carries the clinic-wide P&L, docs/42) and access to every
 * branch. Counts and amounts only, no patient data. Written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.group_pack.export"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const raw = new URL(req.url).searchParams.get("month");
  const ym = raw && MONTH_RE.test(raw) ? raw : lastClosedMonth(todayIn(member.org.timezone));
  const builtAt = new Date().toISOString();
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const input = await loadGroupPackInput(admin, member, `${ym}-01`, builtAt);
    const sheets = buildGroupPack(input);
    const body = await tablesWorkbook({ org: member.org.name, builtAt, sheets });
    const rows = sheets.reduce((a, s) => a + s.rows.length, 0);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.group_pack.exported",
      entity: "fin_period_closes",
      diff: { month: ym, status: input.status, frozen: input.close?.frozen ?? false, rows },
    });
    await recordExport(admin, member, { dataset: "finance:group-pack", rows, format: "xlsx" });
    return new NextResponse(
      new Uint8Array(body),
      xlsxResponseInit(
        `al-das-group-pack-${ym}${input.status === "locked" ? "" : "-provisional"}.xlsx`,
      ),
    );
  } catch (e) {
    if (e instanceof GroupPackScopeError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
