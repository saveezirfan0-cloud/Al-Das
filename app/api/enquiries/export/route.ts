import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { enquiriesToCsv, type ExportableEnquiry } from "@/lib/enquiries/export";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import { fetchEnquiriesByIds, matchingEnquiryIds } from "@/lib/enquiries/query";
import { loadEnquiryContext } from "@/lib/enquiries/server";
import { buildEnquiryFilter } from "@/lib/enquiries/views";
import { filterSchema } from "@/lib/filters/ast";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  scope: z.enum(["open", "closed", "all"]).default("open"),
  pipelineId: z.string().uuid().nullable().optional(),
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  /** Only these enquiries (bulk selection); other fields are then ignored. */
  ids: z.array(z.string().uuid()).max(50_000).optional(),
});

const MAX_EXPORT = 50_000;
const BATCH = 500;

/** POST /api/enquiries/export → text/csv. Requires enquiries.export. */
export async function POST(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "enquiries.export"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const ctx = await loadEnquiryContext(admin, member.orgId);

  let ids: string[];
  if (body.ids) {
    ids = body.ids;
  } else {
    try {
      ids = await matchingEnquiryIds(
        admin,
        {
          orgId: member.orgId,
          registry: ctx.registry,
          filter: buildEnquiryFilter(body),
          search: body.search,
          timezone: member.org.timezone,
        },
        MAX_EXPORT,
      );
    } catch {
      return NextResponse.json({ error: "invalid filter" }, { status: 400 });
    }
  }

  const stageName = new Map(
    ctx.pipelines.flatMap((p) => p.stages.map((s) => [s.id, s.name] as const)),
  );
  const pipelineName = new Map(ctx.pipelines.map((p) => [p.id, p.name]));
  const userName = new Map(ctx.users.map((u) => [u.id, u.label]));
  const name = (list: Array<{ id: string; name: string }>) =>
    new Map(list.map((x) => [x.id, x.name]));
  const loc = name(ctx.lookups.locations);
  const dep = name(ctx.lookups.departments);
  const spec = name(ctx.lookups.specialists);
  const svc = name(ctx.lookups.services);
  const chan = name(ctx.lookups.channels);

  const rows: ExportableEnquiry[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    for (const e of await fetchEnquiriesByIds(admin, member.orgId, ids.slice(i, i + BATCH))) {
      if (e.deleted_at) continue;
      rows.push({
        number: e.number,
        title: e.title,
        status: e.status as EnquiryStatus,
        lost_reason: e.lost_reason,
        pipeline: pipelineName.get(e.pipeline_id) ?? "",
        stage: stageName.get(e.stage_id) ?? "",
        contact_name: e.contact?.full_name ?? null,
        contact_phone: e.contact?.phone_e164 ?? null,
        assignee: e.assignee_id ? (userName.get(e.assignee_id) ?? null) : null,
        source: e.source,
        channel: e.channel_id ? (chan.get(e.channel_id) ?? null) : null,
        est_value: e.est_value,
        location: e.location_id ? (loc.get(e.location_id) ?? null) : null,
        department: e.department_id ? (dep.get(e.department_id) ?? null) : null,
        specialist: e.specialist_id ? (spec.get(e.specialist_id) ?? null) : null,
        service: e.service_id ? (svc.get(e.service_id) ?? null) : null,
        appt_date: e.appt_date,
        created_at: e.created_at,
        created_by: e.created_by ? (userName.get(e.created_by) ?? null) : null,
        closed_at: e.closed_at,
        custom: e.custom,
      });
    }
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "enquiry.exported",
    entity: "enquiry",
    diff: { count: rows.length },
  });

  return new NextResponse(enquiriesToCsv(rows, ctx.customFields), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="enquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
