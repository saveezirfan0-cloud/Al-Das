import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { checkRateLimit, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import {
  fetchAccessLog,
  fetchAlerts,
  fetchAuthEvents,
  memberNames,
} from "@/lib/security/activity-queries";
import {
  accessLogToCsv,
  alertsToCsv,
  authEventsToCsv,
  changesToCsv,
  EXPORT_MAX_ROWS,
  exportFileName,
  parseViewFilters,
  periodStart,
} from "@/lib/security/activity-view";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings/activity/export?view=changes|logins|access|alerts&period=…&actor=…&type=…
 * → text/csv of the Activity log with the same filters as the screen (max 10,000 rows).
 * Requires settings.manage, is rate limited, and is itself written to audit_log and record_access_log.
 */
export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "settings.manage"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "activity-export",
    member.userId,
    RATE_RULES.activityExportPerUser,
  );
  if (!limited.allowed) return tooManyRequests(limited);

  const filters = parseViewFilters(Object.fromEntries(new URL(request.url).searchParams));
  if (filters.view === "api")
    return NextResponse.json({ error: "this view has no export" }, { status: 400 });

  const db = await createClient(); // RLS: only settings.manage may read these tables
  // PostgREST returns at most 1,000 rows per request, so each export reads pages of the same query up to the cap.
  const upToCap = async <T>(page: (range: [number, number]) => Promise<T[]>): Promise<T[]> =>
    (
      await fetchAll(async (from, to) => ({ data: await page([from, to]), error: null }), {
        max: EXPORT_MAX_ROWS,
      })
    ).data ?? [];
  const names = await memberNames(db, member.orgId);
  const who = (id: string | null) => (id ? (names.get(id) ?? "Former member") : "System");

  let csv: string;
  let rows: number;
  if (filters.view === "logins") {
    const data = await upToCap((range) => fetchAuthEvents(db, member.orgId, filters, range));
    rows = data.length;
    csv = authEventsToCsv(
      data.map((r) => ({
        at: r.at,
        who: r.user_id ? who(r.user_id) : "Unknown e-mail",
        event_type: r.event_type,
        method: r.method,
        ua_family: r.ua_family,
        ip_address: r.ip_address,
        ip_hash: r.ip_hash,
      })),
    );
  } else if (filters.view === "access") {
    const data = await upToCap((range) => fetchAccessLog(db, member.orgId, filters, range));
    rows = data.length;
    csv = accessLogToCsv(
      data.map((r) => ({
        at: r.at,
        who: who(r.user_id),
        entity: r.entity,
        entity_id: r.entity_id,
        action: r.action,
        sampled: r.sampled,
        rows:
          typeof (r.detail as { rows?: unknown } | null)?.rows === "number"
            ? (r.detail as { rows: number }).rows
            : null,
      })),
    );
  } else if (filters.view === "alerts") {
    const data = await upToCap((range) => fetchAlerts(db, member.orgId, filters, range));
    rows = data.length;
    csv = alertsToCsv(
      data.map((r) => ({
        at: r.created_at,
        kind: r.kind,
        summary: r.summary,
        acknowledged: !!r.acknowledged_at,
      })),
    );
  } else {
    const since = periodStart(filters.period);
    const { data } = await fetchAll(
      (from, to) => {
        let q = db
          .from("audit_log")
          .select("user_id, action, entity, entity_id, at")
          .eq("org_id", member.orgId);
        if (since) q = q.gte("at", since);
        if (filters.actor) q = q.eq("user_id", filters.actor);
        return q
          .order("at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
      },
      { max: EXPORT_MAX_ROWS },
    );
    rows = data?.length ?? 0;
    csv = changesToCsv(
      (data ?? []).map((r) => ({
        at: r.at,
        who: who(r.user_id),
        action: r.action,
        entity: r.entity,
        entity_id: r.entity_id,
      })),
    );
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "activity_log.exported",
    entity: "activity_log",
    diff: { view: filters.view, period: filters.period, rows },
  });
  await recordExport(admin, member, { dataset: `activity:${filters.view}`, rows });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(filters.view)}"`,
      "Cache-Control": "no-store",
    },
  });
}
