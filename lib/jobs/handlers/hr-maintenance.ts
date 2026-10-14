import { formatInTimeZone } from "date-fns-tz";

import { registerTask } from "@/lib/jobs/tasks";
import type { JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { dueForReminder, reminderHorizon } from "@/lib/organisation/expiry";
import { readOrganisationSettings } from "@/lib/organisation/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * /api/jobs/hr_maintenance (pg_cron daily, 03:55 UTC): visa and licence reminders for staff and doctors (Phase C).
 *
 * Per organisation, every staff visa, staff licence and doctor licence inside the reminder window (Staff, Reminder
 * days; 60 by default) or already past, and not yet reminded, is claimed with an atomic update of its
 * *_expiry_notified_at column, so a retry or an overlapping run never reminds twice; changing the date clears the
 * claim (database trigger) so the new date reminds again. Then ONE notify() per organisation to the people who manage
 * staff (`staff.document_expiring`): ids only in the payload, a fixed generic sentence in push and e-mail.
 * Counts only are logged.
 */
registerTask("hr_maintenance", {
  name: "hr.maintenance",
  run: (admin, log) => runHrMaintenance(admin, log),
});

export type HrMaintenanceTotals = {
  orgs: number;
  visas: number;
  staff_licences: number;
  doctor_licences: number;
  notified_orgs: number;
};

const PAGE = 200;

type Claimed = { kind: "staff" | "doctor"; id: string };

export async function runHrMaintenance(
  admin: AdminClient,
  log: JobLogger,
  now: Date = new Date(),
): Promise<HrMaintenanceTotals> {
  const totals: HrMaintenanceTotals = {
    orgs: 0,
    visas: 0,
    staff_licences: 0,
    doctor_licences: 0,
    notified_orgs: 0,
  };
  const stamp = now.toISOString();

  const { data: orgs } = await admin.from("orgs").select("id, timezone, settings");
  for (const org of orgs ?? []) {
    totals.orgs++;
    const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");
    const lead = readOrganisationSettings(org.settings).expiry_lead_days;
    const horizon = reminderHorizon(today, lead);
    if (!horizon) continue;
    const claimed: Claimed[] = [];

    // Staff visas
    const { data: visas } = await admin
      .from("staff_members")
      .select("id, visa_expires_on, visa_expiry_notified_at")
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .is("visa_expiry_notified_at", null)
      .not("visa_expires_on", "is", null)
      .lte("visa_expires_on", horizon)
      .order("visa_expires_on")
      .limit(PAGE);
    const dueVisas = dueForReminder(
      (visas ?? []).map((r) => ({
        id: r.id,
        expires_on: r.visa_expires_on,
        notified_at: r.visa_expiry_notified_at,
      })),
      today,
      lead,
    );
    for (const r of dueVisas) {
      const { data: won } = await admin
        .from("staff_members")
        .update({ visa_expiry_notified_at: stamp })
        .eq("id", r.id)
        .is("visa_expiry_notified_at", null)
        .select("id")
        .maybeSingle();
      if (won) {
        totals.visas++;
        claimed.push({ kind: "staff", id: r.id });
      }
    }

    // Staff licences
    const { data: licences } = await admin
      .from("staff_members")
      .select("id, licence_expires_on, licence_expiry_notified_at")
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .is("licence_expiry_notified_at", null)
      .not("licence_expires_on", "is", null)
      .lte("licence_expires_on", horizon)
      .order("licence_expires_on")
      .limit(PAGE);
    const dueLicences = dueForReminder(
      (licences ?? []).map((r) => ({
        id: r.id,
        expires_on: r.licence_expires_on,
        notified_at: r.licence_expiry_notified_at,
      })),
      today,
      lead,
    );
    for (const r of dueLicences) {
      const { data: won } = await admin
        .from("staff_members")
        .update({ licence_expiry_notified_at: stamp })
        .eq("id", r.id)
        .is("licence_expiry_notified_at", null)
        .select("id")
        .maybeSingle();
      if (won) {
        totals.staff_licences++;
        claimed.push({ kind: "staff", id: r.id });
      }
    }

    // Doctor licences (specialists)
    const { data: doctors } = await admin
      .from("specialists")
      .select("id, licence_expires_on, licence_expiry_notified_at")
      .eq("org_id", org.id)
      .eq("active", true)
      .is("licence_expiry_notified_at", null)
      .not("licence_expires_on", "is", null)
      .lte("licence_expires_on", horizon)
      .order("licence_expires_on")
      .limit(PAGE);
    const dueDoctors = dueForReminder(
      (doctors ?? []).map((r) => ({
        id: r.id,
        expires_on: r.licence_expires_on,
        notified_at: r.licence_expiry_notified_at,
      })),
      today,
      lead,
    );
    for (const r of dueDoctors) {
      const { data: won } = await admin
        .from("specialists")
        .update({ licence_expiry_notified_at: stamp })
        .eq("id", r.id)
        .is("licence_expiry_notified_at", null)
        .select("id")
        .maybeSingle();
      if (won) {
        totals.doctor_licences++;
        claimed.push({ kind: "doctor", id: r.id });
      }
    }

    if (claimed.length === 0) continue;
    const recipients = await memberIdsWithPermission(admin, org.id, "hr.manage");
    if (recipients.length === 0) continue;
    const single = claimed.length === 1 ? claimed[0] : null;
    const payload: Record<string, Json> = single
      ? single.kind === "staff"
        ? { staff_member_id: single.id }
        : { specialist_id: single.id }
      : { count: claimed.length };
    await notify(admin, {
      orgId: org.id,
      userIds: recipients,
      event: "staff.document_expiring",
      type: "staff.document_expiring",
      title: single
        ? "A staff visa or licence is about to expire"
        : `${claimed.length} staff visas or licences are about to expire`,
      body: single
        ? "Open the record to see which date."
        : "Open Staff and Doctors to see the expiry badges.",
      payload: payload as NonNullable<Json>,
      ids: {},
    });
    totals.notified_orgs++;
  }

  log.info("hr maintenance done", totals);
  return totals;
}
