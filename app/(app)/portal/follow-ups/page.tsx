import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadClinicalSettings } from "@/lib/clinical/engine";
import { formatPhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";

import { FollowUpQueue, type FollowUpRow } from "./queue";

export const metadata = { title: "Follow-Up Queue" };

export default async function FollowUpsPage() {
  const member = await requirePerm("portal.clinical_followups.read");
  const admin = createAdminClient();
  const canSeeVisits = can(member, "portal.clinical_visits.read");

  const gateOn = (await loadClinicalSettings(admin, member.orgId)).messagingEnabled();
  const [{ data: queue }, { count: unsigned }, { data: memberRows }, { data: scripts }] =
    await Promise.all([
      admin
        .from("v_followup_queue")
        .select("*")
        .eq("org_id", member.orgId)
        .order("priority", { ascending: true })
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(500),
      admin
        .from("visit_rule_evaluations")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("is_current", true)
        .not("missing_settings", "eq", "{}"),
      admin
        .from("memberships")
        .select("user_id, profiles(first_name, last_name, email)")
        .eq("org_id", member.orgId)
        .eq("status", "active"),
      admin
        .from("clinical_call_scripts")
        .select("trigger_category, script, clinical_approval")
        .eq("org_id", member.orgId),
    ]);

  const rows = queue ?? [];
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter((x): x is string => !!x))];
  const [{ data: contacts }, { data: visits }] = await Promise.all([
    contactIds.length
      ? admin
          .from("contacts")
          .select("id, full_name, phone_e164")
          .eq("org_id", member.orgId)
          .in("id", contactIds)
      : Promise.resolve({ data: [] }),
    canSeeVisits && visitIds.length
      ? admin
          .from("visits")
          .select("id, temp_c, bp_systolic, bp_diastolic, spo2, pulse")
          .eq("org_id", member.orgId)
          .in("id", visitIds)
      : Promise.resolve({ data: [] }),
  ]);
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));
  const visitById = new Map((visits ?? []).map((v) => [v.id, v]));
  // Only approved scripts are shown to staff; a draft script is never read to a patient.
  const scriptByCategory = new Map(
    (scripts ?? [])
      .filter((s) => s.clinical_approval === "approved" && s.trigger_category)
      .map((s) => [s.trigger_category as string, s.script]),
  );

  const items: FollowUpRow[] = rows.map((r) => {
    const c = r.contact_id ? contactById.get(r.contact_id) : undefined;
    const v = r.visit_id ? visitById.get(r.visit_id) : undefined;
    return {
      id: r.id ?? "",
      ref: r.ref,
      patient: c?.full_name || "Unmatched patient",
      phone: c?.phone_e164 ? formatPhone(c.phone_e164) : null,
      priority: r.priority ?? "medium",
      dueDate: r.due_date,
      category: r.trigger_category,
      rulesFired: r.rules_fired ?? [],
      department: r.department_effective,
      doctor: r.doctor_name,
      visitDate: r.visit_date,
      ageAtVisit: r.age_at_visit,
      callStatus: r.call_status ?? "pending",
      outcome: r.outcome,
      escalationStatus: r.escalation_status ?? "none",
      doctorNotified: !!r.doctor_notified_at,
      doctorAlert: !!r.doctor_alert_required,
      doctorResponseNotes: r.doctor_response_notes,
      notes: r.notes,
      assignedUserId: r.assigned_user_id,
      source: r.source ?? "engine",
      isTest: !!r.is_test_record,
      vitals: v
        ? {
            temp: v.temp_c,
            bp:
              v.bp_systolic !== null && v.bp_diastolic !== null
                ? `${v.bp_systolic}/${v.bp_diastolic}`
                : null,
            spo2: v.spo2,
            pulse: v.pulse,
          }
        : null,
      script: r.trigger_category ? (scriptByCategory.get(r.trigger_category) ?? null) : null,
    };
  });

  const members = (memberRows ?? []).map((m) => {
    const p = m.profiles as { first_name: string; last_name: string; email: string | null } | null;
    return {
      id: m.user_id,
      name: [p?.first_name, p?.last_name].filter(Boolean).join(" ") || p?.email || "Member",
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Follow-Up Queue"
        description="Visits that tripped a clinical rule. Work the list from the top: High first, then oldest due date."
      />
      {!gateOn && (
        <Alert>
          <AlertTitle>Patient-facing clinical messages are OFF</AlertTitle>
          <AlertDescription>
            Nothing is sent to patients automatically. Internal follow-ups below are still created.
            Switching messaging on needs the clinical lead&apos;s sign-off in Clinical settings.
          </AlertDescription>
        </Alert>
      )}
      {(unsigned ?? 0) > 0 && (
        <Alert>
          <AlertTitle>
            {unsigned} visit{unsigned === 1 ? "" : "s"} evaluated with unsigned settings
          </AlertTitle>
          <AlertDescription>
            Rules that depend on an unsigned threshold do not fire, so these lists may be incomplete
            until the settings are signed off. They are re-evaluated automatically.
          </AlertDescription>
        </Alert>
      )}
      <FollowUpQueue
        items={items}
        members={members}
        canWrite={can(member, "portal.clinical_followups.write")}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}
