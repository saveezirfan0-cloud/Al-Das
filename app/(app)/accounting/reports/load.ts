import "server-only";

import { ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { loadBranchCodeOptions } from "@/lib/accounting/accounting-server";
import { pickBranchCode, type BranchCodeOption } from "@/lib/branches/codes";
import { parseStatementParams, type StatementReport } from "@/lib/accounting/statements/params";
import {
  buildStatement,
  mayOpenReport,
  REPORT_PERMISSIONS,
  statementContext,
} from "@/lib/accounting/statements/server";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

type Search = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Phase B: the statements whose figures can be narrowed to one branch's journal lines. */
const BRANCH_FILTERED: readonly StatementReport[] = ["balance-sheet", "cash-flow"];

/**
 * What every statement page does first: the permission check (any key of REPORT_PERMISSIONS), then the service-role
 * client, the chart and entities, the options from the link, and the statement itself.
 */
export async function loadReportPage(
  report: StatementReport,
  searchParams: Promise<Search>,
  defaults?: (c: {
    fy: { start: string; end: string };
    today: string;
    admin: AdminClient;
    orgId: string;
    entityId: string | null;
  }) => { from: string; to: string } | Promise<{ from: string; to: string }>,
) {
  const member = await requireMember();
  if (!mayOpenReport(member, report)) throw new ForbiddenError(REPORT_PERMISSIONS[report][0]);
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const rawEntity = typeof sp.entity === "string" && UUID.test(sp.entity) ? sp.entity : null;
  const ctx = await statementContext(admin, member.orgId, rawEntity, today);
  const p = parseStatementParams(
    sp,
    defaults
      ? await defaults({
          fy: ctx.fy,
          today,
          admin,
          orgId: member.orgId,
          entityId: ctx.entity?.id ?? null,
        })
      : { from: ctx.fy.start, to: today < ctx.fy.start ? ctx.fy.start : today },
  );
  // Phase B: a branch filter must be one of the org's finance codes; anything else shows every branch.
  let branchOptions: BranchCodeOption[] = [];
  if (BRANCH_FILTERED.includes(report)) {
    branchOptions = await loadBranchCodeOptions(admin, member.orgId);
    p.branch = pickBranchCode(p.branch, branchOptions);
  }
  const built = await buildStatement(admin, member, report, p, ctx);
  return { member, admin, today, ctx, p, built, branchOptions };
}
