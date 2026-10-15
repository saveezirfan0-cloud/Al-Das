import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { canAll } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { uuid } from "@/lib/finance/action-support";
import {
  recruitmentInputsSchema,
  SCENARIO_ENGINE,
  type ScenarioReport,
} from "@/lib/finance/recruitment";
import { RECRUIT_PERMS } from "@/lib/finance/recruitment-server";
import { recruitmentWorkbook } from "@/lib/finance/recruitment-xlsx";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/recruitment/<scenario id> -> the saved recruitment scenario as an .xlsx (values only, "Scenario"
 * banner). Needs finance.profit.view AND finance.costs.compensation (the inputs are pay terms). Built from the stored
 * scenario only. Audited and written to the access log as an export.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAll(member, RECRUIT_PERMS))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const { data: row, error } = await admin
      .from("fin_recruitment_scenarios")
      .select("id, title, inputs, result, created_at")
      .eq("org_id", member.orgId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    const inputs = recruitmentInputsSchema.safeParse(row.inputs);
    const report = row.result as unknown as ScenarioReport;
    if (!inputs.success || report?.engine !== SCENARIO_ENGINE)
      return NextResponse.json({ error: "unreadable scenario" }, { status: 422 });

    const body = await recruitmentWorkbook({
      org: member.org.name,
      title: row.title,
      createdAt: row.created_at,
      inputs: inputs.data,
      report,
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.recruitment.scenario_exported",
      entity: "fin_recruitment_scenarios",
      entityId: row.id,
    });
    await recordExport(admin, member, {
      dataset: "finance:recruitment-scenario",
      rows: 1,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="recruitment-scenario-${row.id.slice(0, 8)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
