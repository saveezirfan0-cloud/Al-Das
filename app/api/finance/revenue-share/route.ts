import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { readSnapshot, runTrailCsv, type RunStatus } from "@/lib/finance/revshare";
import { MONTH_RE, profileNames } from "@/lib/finance/revshare-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/revenue-share?month=yyyy-mm -> text/csv: the month's run as a trail (every calculation step per
 * doctor, the sign-offs, the accounting reference and each payment). Doctor compensation: needs a finance.revshare.*
 * key. Rendered from the stored snapshot, never from live data. Audited and written to the access log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (
    !canAny(member, [
      "finance.revshare.view",
      "finance.revshare.manage",
      "finance.revshare.verify",
      "finance.revshare.approve",
    ])
  )
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!MONTH_RE.test(month)) return NextResponse.json({ error: "choose a month" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: run } = await admin
    .from("fin_revshare_runs")
    .select("*")
    .eq("org_id", member.orgId)
    .eq("month", `${month}-01`)
    .maybeSingle();
  const snap = run ? readSnapshot(run.snapshot) : null;
  if (!run || !snap) return NextResponse.json({ error: "no run for this month" }, { status: 404 });
  const { data: lines } = await admin
    .from("fin_revshare_lines")
    .select("doctor_dha_id, paid_on, payment_ref")
    .eq("run_id", run.id);
  const name = await profileNames(admin, [run.verified_by, run.approved_by]);
  const csv = runTrailCsv(snap, {
    status: run.status as RunStatus,
    snapshot_hash: run.snapshot_hash,
    built_at: run.built_at,
    verified_by: name(run.verified_by),
    verified_at: run.verified_at,
    approved_by: name(run.approved_by),
    approved_at: run.approved_at,
    posted_ref: run.posted_ref,
    posted_at: run.posted_at,
    lines: lines ?? [],
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.exported",
    entity: "fin_revshare_runs",
    entityId: run.id,
    diff: { month, doctors: snap.results.length },
  });
  await recordExport(admin, member, {
    dataset: "finance:revenue-share",
    rows: snap.results.length,
  });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="revenue-share-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
