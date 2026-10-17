import { notFound } from "next/navigation";
import { z } from "zod";

import { can, canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadPatientHeader } from "@/lib/contacts/patient-360-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { PatientRecord, type RecordAccess } from "./patient-record";

export const metadata = { title: "Patient record" };
export const dynamic = "force-dynamic";

/**
 * Patient 360 (docs/45 P3): the full record of one patient. Each tab checks its own permission (clinical tabs need
 * clinical.view, never implied by contacts.view) and loads when opened. Opening the page is recorded (id only).
 */
export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const member = await requirePerm("contacts.view");
  const { id } = await params;
  const { tab } = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const header = await loadPatientHeader(member, id);
  if (!header) notFound();

  const admin = createAdminClient();
  await recordAccess(admin, member, {
    entity: "contact",
    entityId: id,
    action: "view",
    detail: { surface: "patient_360" },
  });

  const { data: members } = can(member, "tasks.view")
    ? await admin
        .from("memberships")
        .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
        .eq("org_id", member.orgId)
        .eq("status", "active")
    : { data: [] };
  const users = (members ?? []).map((m) => ({
    id: m.user_id,
    label:
      `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
      m.profiles?.email ||
      "Colleague",
  }));

  const access: RecordAccess = {
    appointments: can(member, "appointments.view"),
    clinical: can(member, "clinical.view"),
    conversations: canAny(member, ["inbox.send", "inbox.view_all"]),
    enquiries: can(member, "enquiries.view"),
    enquiriesManage: can(member, "enquiries.manage"),
    campaigns: can(member, "campaigns.view"),
    invoices: can(member, "finance.invoices.view"),
    documents: can(member, "documents.view"),
    tasks: can(member, "tasks.view"),
  };

  return (
    <PatientRecord
      header={header}
      access={access}
      timezone={member.org.timezone}
      users={users}
      initialTab={tab ?? "overview"}
    />
  );
}
