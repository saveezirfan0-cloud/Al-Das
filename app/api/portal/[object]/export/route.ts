import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { filterSchema } from "@/lib/filters/ast";
import { portalRowsToCsv } from "@/lib/portal/export";
import { fetchPortalRows, matchingPortalIds, MAX_EXPORT } from "@/lib/portal/query";
import { loadPortalRegistry, resolveEnabledObject } from "@/lib/portal/server";
import { resolveLinks } from "@/lib/portal/service";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  scope: z.enum(["current", "all"]).default("current"),
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  columns: z.array(z.string().max(80)).max(100).optional(),
});

const BATCH = 500;

/** POST /api/portal/[object]/export → text/csv. Requires the object's read permission; rows come back oldest first. */
export async function POST(req: Request, ctx: { params: Promise<{ object: string }> }) {
  const { object } = await ctx.params;
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const admin = createAdminClient();
  const def = await resolveEnabledObject(admin, member.orgId, object);
  // Unknown and forbidden look the same.
  if (!def || !can(member, def.readPerm))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;

  const { registry } = await loadPortalRegistry(admin, member.orgId, def);
  const current = body.scope === "current";
  let ids: string[];
  try {
    ids = await matchingPortalIds(
      admin,
      member.orgId,
      def,
      registry,
      current ? body.filter : null,
      current ? body.search : null,
      MAX_EXPORT,
      member.org.timezone,
    );
  } catch {
    return NextResponse.json({ error: "invalid filter" }, { status: 400 });
  }

  const rows = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    rows.push(...(await fetchPortalRows(admin, member.orgId, def, ids.slice(i, i + BATCH))));
  }
  const linkTitles = await resolveLinks(admin, member.orgId, def, rows);
  const csv = portalRowsToCsv(def, rows, { columns: body.columns, linkTitles });

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "portal.exported",
    entity: def.key,
    diff: { scope: body.scope, rows: rows.length },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${def.key}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
