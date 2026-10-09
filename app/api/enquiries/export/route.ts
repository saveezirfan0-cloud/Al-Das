import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { activityCsv, enquiriesCsv } from "@/lib/enquiries/export";
import { enquiryFilterSchema } from "@/lib/enquiries/filter";
import { exportActivity, exportRows } from "@/lib/enquiries/service";
import { checkRateLimit, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  kind: z.enum(["enquiries", "activity"]).default("enquiries"),
  filter: enquiryFilterSchema.default(() => enquiryFilterSchema.parse({})),
});

/** POST /api/enquiries/export → text/csv. Requires enquiries.manage (exports carry patient details). */
export async function POST(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "enquiries.manage"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const { kind, filter } = parsed.data;

  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "enquiries-export",
    member.userId,
    RATE_RULES.enquiriesExportPerUser,
  );
  if (!limited.allowed) return tooManyRequests(limited);

  const actor = { orgId: member.orgId, userId: member.userId };
  let csv: string;
  let count: number;
  let truncated: boolean;
  if (kind === "activity") {
    const res = await exportActivity(admin, actor, filter);
    csv = activityCsv(res.rows);
    count = res.rows.length;
    truncated = res.truncated;
  } else {
    const res = await exportRows(admin, actor, filter);
    csv = enquiriesCsv(res.rows, res.customLabels);
    count = res.rows.length;
    truncated = res.truncated;
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "enquiry.exported",
    entity: "enquiry",
    diff: { kind, count, truncated },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="enquiries-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "true" } : {}),
    },
  });
}
