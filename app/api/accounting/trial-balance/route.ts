import { NextResponse } from "next/server";

import {
  loadAccounts,
  loadBranchCodeOptions,
  loadEntities,
  loadTrialBalance,
} from "@/lib/accounting/accounting-server";
import { buildTrialBalance, rangeProblem } from "@/lib/accounting/reports";
import { trialBalanceWorkbook } from "@/lib/accounting/tb-xlsx";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { pickBranchCode } from "@/lib/branches/codes";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/accounting/trial-balance?from=yyyy-mm-dd&to=yyyy-mm-dd[&entity=<id>][&branch=<code>] -> the trial balance workbook. Requires
 * accounting.reports.view. Account codes, names and amounts only. Written to the audit trail and the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "accounting.reports.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const from = (sp.get("from") ?? "").slice(0, 10);
  const to = (sp.get("to") ?? "").slice(0, 10);
  if (rangeProblem(from, to)) return NextResponse.json({ error: "bad range" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const [entities, accounts, branchOptions] = await Promise.all([
      loadEntities(admin, member.orgId),
      loadAccounts(admin, member.orgId),
      loadBranchCodeOptions(admin, member.orgId),
    ]);
    const entity = entities.find((e) => e.id === sp.get("entity")) ?? null;
    const branch = pickBranchCode(sp.get("branch"), branchOptions);
    const data = await loadTrialBalance(admin, member.orgId, entity?.id ?? null, from, to, branch);
    const tb = buildTrialBalance(accounts, data);
    const scope = [
      entities.length > 1 ? (entity?.name ?? "All entities") : null,
      branch ? `Branch ${branch} (lines naming it)` : null,
    ].filter((x): x is string => !!x);
    const body = await trialBalanceWorkbook({
      org: member.org.name,
      entity: scope.length ? scope.join(", ") : null,
      from,
      to,
      tb,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.trial_balance.exported",
      entity: "acc_journals",
      diff: { from, to, entity: entity?.id ?? null, branch },
    });
    await recordExport(admin, member, {
      dataset: "accounting:trial_balance",
      rows: tb.lines.length,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="trial-balance-${from}-${to}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
