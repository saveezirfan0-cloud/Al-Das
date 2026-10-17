import "server-only";

import { can } from "@/lib/auth/can";
import type { CurrentMember } from "@/lib/auth/session";
import { readLifecycleSettings } from "@/lib/contacts/lifecycle-settings";
import {
  ageLabel,
  consentChips,
  headerLifecycle,
  type ConsentChip,
} from "@/lib/contacts/patient-360";
import type { LifecycleStage } from "@/lib/contacts/lifecycle";
import { loadPatientBilling } from "@/lib/contacts/patient-billing-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Header data of the Patient 360 page. Contact, household, appointment and condition reads go through the member's own
 * client (RLS: contact visibility, branch rule, clinical gate). The lifecycle stage is derived from visit dates only
 * (service role, org and contact scoped, dates never leave this function). Serialisable.
 */

export type HouseholdMember = {
  id: string;
  name: string;
  relationship: string;
  remindersToGuardian: boolean;
};

export type PatientHeader = {
  id: string;
  name: string;
  age: string | null;
  gender: string | null;
  unitePin: string | null;
  phone: string | null;
  homeBranch: string | null;
  lifecycle: LifecycleStage;
  /** Only filled for members with clinical.view. */
  chronic: string[] | null;
  consent: ConsentChip[];
  guardian: HouseholdMember | null;
  dependants: HouseholdMember[];
  nextAppointment: {
    startsAt: string;
    status: string;
    branch: string | null;
    doctor: string | null;
  } | null;
  openTasks: number | null;
  /**
   * What the patient still owes (AED), from the Unite invoices matched by PIN. Only for members with
   * finance.invoices.view; null otherwise or when the patient has no PIN. `partial` = some insurance invoices were left
   * out because the member lacks finance.claims.view.
   */
  balance: { due: number; credit: number; insurerOutstanding: number; partial: boolean } | null;
};

function orgToday(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export async function loadPatientHeader(
  member: CurrentMember,
  contactId: string,
): Promise<PatientHeader | null> {
  const supabase = await createClient();
  const { data: c } = await supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, dob, gender, external_id, phone_e164, location_id, promotions_opt_in, stop_marketing, clinical_messaging_consent, whatsapp_declined_at, deleted_at, merged_into_id",
    )
    .eq("org_id", member.orgId)
    .eq("id", contactId)
    .maybeSingle();
  if (!c || c.deleted_at || c.merged_into_id) return null;

  const today = orgToday(member.org.timezone);
  const clinical = can(member, "clinical.view");
  const nowIso = new Date().toISOString();
  const admin = createAdminClient();

  const [loc, guardLink, depLinks, stats, chronic, appt, tasks] = await Promise.all([
    c.location_id
      ? supabase
          .from("locations")
          .select("name")
          .eq("org_id", member.orgId)
          .eq("id", c.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("household_links")
      .select("guardian_contact_id, relationship, reminders_to_guardian")
      .eq("org_id", member.orgId)
      .eq("dependant_contact_id", contactId)
      .maybeSingle(),
    supabase
      .from("household_links")
      .select("dependant_contact_id, relationship, reminders_to_guardian")
      .eq("org_id", member.orgId)
      .eq("guardian_contact_id", contactId)
      .limit(20),
    admin
      .from("v_contact_visit_stats")
      .select("first_visit_date, last_visit_date")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .maybeSingle(),
    clinical
      ? supabase
          .from("contact_chronic_conditions")
          .select("ref_diagnoses(short_description, code)")
          .eq("org_id", member.orgId)
          .eq("contact_id", contactId)
          .limit(8)
      : Promise.resolve({ data: null }),
    can(member, "appointments.view")
      ? supabase
          .from("appointments")
          .select("starts_at, status, location_id, specialist_id")
          .eq("org_id", member.orgId)
          .eq("contact_id", contactId)
          .gte("starts_at", nowIso)
          .in("status", ["awaiting", "confirmed"])
          .order("starts_at")
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    can(member, "tasks.view")
      ? supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("org_id", member.orgId)
          .eq("contact_id", contactId)
          .eq("done", false)
      : Promise.resolve({ count: null }),
  ]);

  // Names of the household members and the appointment's branch and doctor.
  const otherIds = [
    guardLink.data?.guardian_contact_id,
    ...(depLinks.data ?? []).map((d) => d.dependant_contact_id),
  ].filter((x): x is string => !!x);
  const [others, apptLoc, apptDoc] = await Promise.all([
    otherIds.length
      ? supabase
          .from("contacts")
          .select("id, first_name, last_name, deleted_at")
          .eq("org_id", member.orgId)
          .in("id", otherIds)
      : Promise.resolve({ data: [] }),
    appt.data?.location_id
      ? supabase
          .from("locations")
          .select("name")
          .eq("org_id", member.orgId)
          .eq("id", appt.data.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    appt.data?.specialist_id
      ? supabase
          .from("specialists")
          .select("name")
          .eq("org_id", member.orgId)
          .eq("id", appt.data.specialist_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const nameOf = new Map(
    (others.data ?? [])
      .filter((o) => !o.deleted_at)
      .map((o) => [o.id, `${o.first_name} ${o.last_name}`.trim() || "Patient"]),
  );

  const guardianId = guardLink.data?.guardian_contact_id;
  const billing = await loadPatientBilling(member, contactId);
  if (billing?.linked)
    await recordAccess(admin, member, {
      entity: "finance_invoice",
      action: "list",
      detail: { rows: billing.rows.length, source: "patient_360_header" },
    });
  return {
    id: c.id,
    name: `${c.first_name} ${c.last_name}`.trim() || "Patient",
    age: ageLabel(c.dob, today),
    gender: c.gender,
    unitePin: c.external_id?.trim() || null,
    phone: c.phone_e164,
    homeBranch: loc.data?.name ?? null,
    lifecycle: headerLifecycle(
      {
        unitePin: c.external_id,
        firstVisitDate: stats.data?.first_visit_date ?? null,
        lastVisitDate: stats.data?.last_visit_date ?? null,
      },
      today,
      readLifecycleSettings(member.org.settings),
    ),
    chronic: clinical
      ? (chronic.data ?? [])
          .map((r) => r.ref_diagnoses?.short_description ?? r.ref_diagnoses?.code ?? null)
          .filter((x): x is string => !!x)
      : null,
    consent: consentChips(c),
    guardian:
      guardianId && guardLink.data && nameOf.has(guardianId)
        ? {
            id: guardianId,
            name: nameOf.get(guardianId)!,
            relationship: guardLink.data.relationship,
            remindersToGuardian: guardLink.data.reminders_to_guardian,
          }
        : null,
    dependants: (depLinks.data ?? [])
      .filter((d) => nameOf.has(d.dependant_contact_id))
      .map((d) => ({
        id: d.dependant_contact_id,
        name: nameOf.get(d.dependant_contact_id)!,
        relationship: d.relationship,
        remindersToGuardian: d.reminders_to_guardian,
      })),
    nextAppointment: appt.data
      ? {
          startsAt: appt.data.starts_at,
          status: appt.data.status,
          branch: apptLoc.data?.name ?? null,
          doctor: apptDoc.data?.name ?? null,
        }
      : null,
    openTasks: tasks.count ?? null,
    balance:
      billing && billing.linked
        ? {
            due: billing.summary.patientDue,
            credit: billing.summary.patientCredit,
            insurerOutstanding: billing.summary.insurerOutstanding,
            partial: billing.summary.skipped > 0,
          }
        : null,
  };
}
