import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { buildPatientExport } from "@/lib/privacy/export-bundle";
import { checkRateLimit, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import { canExecute, exportCounts } from "@/lib/security/privacy";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/privacy/requests/<id>/export → the patient's data as JSON.
 * Needs privacy.manage and an APPROVED export request (a second administrator signed it off). The download
 * is single-use: the request becomes "completed" and a second download cannot be generated.
 * POST, not GET, so a link on another site cannot trigger it with the admin's cookie.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "privacy.manage"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "privacy-export",
    member.userId,
    RATE_RULES.privacyExportPerUser,
  );
  if (!limited.allowed) return tooManyRequests(limited);

  const { data: req } = await admin
    .from("privacy_requests")
    .select("id, kind, status, contact_id, requested_by")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!req || req.kind !== "export")
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const verdict = canExecute({
    kind: "export",
    status: req.status as "approved",
    requestedBy: req.requested_by,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 });

  // Claim the request first so two parallel clicks cannot both download.
  const { data: claimed } = await admin
    .from("privacy_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved")
    .select("id");
  if (!claimed?.length) return NextResponse.json({ error: "already downloaded" }, { status: 409 });

  const bundle = await buildPatientExport(admin, member.orgId, req.contact_id);
  if (!bundle) {
    await admin
      .from("privacy_requests")
      .update({ status: "approved", completed_at: null })
      .eq("id", id);
    return NextResponse.json({ error: "patient not found or already erased" }, { status: 404 });
  }
  const counts = exportCounts(bundle);
  await admin
    .from("privacy_requests")
    .update({ result: counts as NonNullable<Json> })
    .eq("id", id);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "privacy.export_generated",
    entity: "privacy_request",
    entityId: id,
    diff: counts,
  });
  await recordExport(admin, member, {
    dataset: "privacy:patient",
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    format: "json",
  });

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="patient-data-${id.slice(0, 8)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
