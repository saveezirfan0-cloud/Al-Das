import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { loadCapacity, loadCapacityScope } from "@/lib/capacity/server";
import { todayIn } from "@/lib/finance/action-support";
import { appointmentBillingWorkbook } from "@/lib/finance/appointment-billing-xlsx";
import {
  latestAppointmentMonth,
  loadAppointmentBilling,
} from "@/lib/finance/appointment-billing-server";
import { monthParam } from "@/lib/finance/doctor-performance";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/finance/appointment-billing?month=yyyy-mm&location=<id|all> -> the appointments and invoices workbook (Summary,
 * Seen not billed, Billed not seen, Review, Doctors, Rooms, Definitions). Requires finance.revenue.view and keeps to the
 * member's branches. Appointment ids, invoice numbers, dates, doctor and room names and counts only, no patient data.
 * Written to the access log and the audit trail.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.revenue.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const scope = await loadCapacityScope(admin, member, sp.get("location"));
    const month =
      monthParam(sp.get("month")) ??
      (await latestAppointmentMonth(admin, member.orgId)) ??
      `${todayIn(member.org.timezone).slice(0, 7)}-01`; // same default as the page
    const capacity = await loadCapacity(admin, member.orgId, scope, month);
    const report = await loadAppointmentBilling(admin, member.orgId, scope, month, capacity);
    const { data: branches } = await admin
      .from("fin_ref_branches")
      .select("code, name")
      .eq("org_id", member.orgId);
    const chosenName = scope.locations.find((l) => l.id === scope.chosen)?.name;
    const body = await appointmentBillingWorkbook({
      org: member.org.name,
      report,
      branchLabel: chosenName ?? "All your branches",
      branchNames: Object.fromEntries((branches ?? []).map((b) => [b.code, b.name])),
      builtAt: new Date().toISOString(),
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.appointment_billing.exported",
      entity: "fin_appt_rows",
      diff: {
        month: month.slice(0, 7),
        branch: scope.chosen ? "one" : "all",
        rows: report.counts.total,
      },
    });
    await recordExport(admin, member, {
      dataset: "finance:appointment-billing",
      rows: report.counts.total,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="appointments-invoices-${month.slice(0, 7)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
