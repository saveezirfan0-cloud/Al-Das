import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { reportCsv, type ReportRow } from "@/lib/campaigns/funnel";
import { reportRecipients } from "@/lib/campaigns/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/campaigns/<id>/report — per-recipient CSV. Needs campaigns.view; RLS scopes the rows. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(member, "campaigns.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const supabase = await createClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows: ReportRow[] = [];
  for await (const page of reportRecipients(supabase, id)) {
    for (const r of page)
      rows.push({
        name: r.name,
        phone: r.phone,
        status: r.status,
        skip_reason: r.skip_reason,
        round: r.round,
        sent_at: r.sent_at,
        delivered_at: r.delivered_at,
        read_at: r.read_at,
        replied_at: r.replied_at,
        error_code: r.error_code,
        error_message: r.error_message,
      });
  }

  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.report_downloaded",
    entity: "campaign",
    entityId: id,
    diff: { rows: rows.length },
  });

  const safe =
    campaign.name
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "campaign";
  return new NextResponse(reportCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}-report.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
