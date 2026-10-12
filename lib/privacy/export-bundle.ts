import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import { exportCounts, type ExportSection } from "@/lib/security/privacy";

/**
 * Subject-access export: everything Pulse holds about one patient, as one JSON document. Explicit column
 * lists (no `select *`), so a new column never leaks into an export without a decision. Media files and
 * patient documents are listed by name only; the files themselves are not included.
 */

const MESSAGE_CAP = 20_000;
const ROW_CAP = 5_000;

export type ExportBundle = {
  generated_at: string;
  contact_id: string;
  truncated: string[];
} & Partial<Record<ExportSection, unknown>>;

export async function buildPatientExport(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<ExportBundle | null> {
  const { data: contact } = await admin
    .from("contacts")
    .select(
      "id, first_name, last_name, phone_e164, email, gender, nationality, country, language, dob, label, source, external_id, promotions_opt_in, stop_marketing, clinical_messaging_consent, promotions_consent, custom, created_at, last_interaction_at, deleted_at, erased_at",
    )
    .eq("id", contactId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!contact || contact.erased_at) return null;

  const truncated: string[] = [];
  const cap = <T>(name: string, rows: T[] | null, limit: number): T[] => {
    const list = rows ?? [];
    if (list.length >= limit) truncated.push(name);
    return list;
  };

  const { data: conversations } = await admin
    .from("conversations")
    .select("id, status, opened_at, closed_at, summary, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .limit(ROW_CAP);
  const conversationIds = (conversations ?? []).map((c) => c.id);

  const [
    phones,
    tags,
    appointments,
    enquiries,
    tasks,
    timeline,
    visits,
    prescriptions,
    followups,
    feedback,
    documents,
    messages,
  ] = await Promise.all([
    admin
      .from("contact_phones")
      .select("phone_e164, label, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId),
    admin.from("contact_tags").select("tags(name)").eq("contact_id", contactId),
    admin
      .from("appointments")
      .select("number, starts_at, ends_at, status, notes, source, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .order("starts_at")
      .limit(ROW_CAP),
    admin
      .from("enquiries")
      .select("number, title, status, source, est_value, lost_reason, created_at, closed_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .order("created_at")
      .limit(ROW_CAP),
    admin
      .from("tasks")
      .select("type, subject, notes, due_at, done, done_at, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .order("due_at")
      .limit(ROW_CAP),
    admin
      .from("timeline_events")
      .select("type, actor_type, payload, at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .order("at")
      .limit(ROW_CAP),
    admin
      .from("visits")
      .select(
        "visit_date, doctor_name, department_raw, height_cm, weight_kg, temp_c, pulse, bp_systolic, bp_diastolic, spo2, description, complaints, hpi, doctor_notes, nurse_notes, plan_of_treatment, primary_diagnosis_text",
      )
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .order("visit_date")
      .limit(ROW_CAP),
    admin
      .from("prescriptions")
      .select(
        "medication_name, class, duration_days, dosage_instruction, total_quantity, start_date",
      )
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .limit(ROW_CAP),
    admin
      .from("clinical_followups")
      .select("due_date, priority, call_status, outcome, notes, closed_at, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .limit(ROW_CAP),
    admin
      .from("clinical_feedback")
      .select("stage, score, reply_text, symptoms_reported, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .limit(ROW_CAP),
    admin
      .from("patient_documents")
      .select("title, category, mime_type, size_bytes, expires_on, scan_status, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .eq("status", "ready")
      .order("created_at")
      .limit(ROW_CAP),
    conversationIds.length
      ? admin
          .from("messages")
          .select("conversation_id, direction, kind, body, media_filename, status, at")
          .eq("org_id", orgId)
          .in("conversation_id", conversationIds)
          .neq("direction", "note") // internal staff notes are not the patient's data
          .order("at")
          .limit(MESSAGE_CAP)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  return {
    generated_at: new Date().toISOString(),
    contact_id: contactId,
    contact,
    phones: phones.data ?? [],
    tags: (tags.data ?? []).map((t) => t.tags?.name).filter(Boolean),
    appointments: cap("appointments", appointments.data, ROW_CAP),
    enquiries: cap("enquiries", enquiries.data, ROW_CAP),
    tasks: cap("tasks", tasks.data, ROW_CAP),
    conversations: conversations ?? [],
    messages: cap("messages", messages.data, MESSAGE_CAP),
    timeline: cap("timeline", timeline.data, ROW_CAP),
    visits: cap("visits", visits.data, ROW_CAP),
    prescriptions: cap("prescriptions", prescriptions.data, ROW_CAP),
    followups: cap("followups", followups.data, ROW_CAP),
    feedback: cap("feedback", feedback.data, ROW_CAP),
    // The files themselves are not part of the bundle; each is listed with its title, category, size and dates.
    documents: cap("documents", documents.data, ROW_CAP),
    truncated,
  };
}

export { exportCounts };
