import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll, type FetchAllResult } from "@/lib/supabase/fetch-all";
import { exportCounts, type ExportSection } from "@/lib/security/privacy";

/**
 * Subject-access export: everything Pulse holds about one patient, as one JSON document. Explicit column
 * lists (no `select *`), so a new column never leaks into an export without a decision. Media files and
 * patient documents are listed by name only; the files themselves are not included.
 *
 * Each list is read in pages (PostgREST returns at most 1,000 rows per request) up to its cap; a list that
 * reaches its cap is named in `truncated`.
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
  const cap = <T>(name: string, res: FetchAllResult<T> | { data: T[] | null }): T[] => {
    if ("truncated" in res && res.truncated) truncated.push(name);
    return res.data ?? [];
  };

  const { data: conversations } = await fetchAll(
    (from, to) =>
      admin
        .from("conversations")
        .select("id, status, opened_at, closed_at, summary, created_at")
        .eq("org_id", orgId)
        .eq("contact_id", contactId)
        .order("id")
        .range(from, to),
    { max: ROW_CAP },
  );
  const conversationIds = (conversations ?? []).map((c) => c.id);

  const [
    phones,
    tags,
    appointments,
    enquiries,
    tasks,
    timeline,
    visits,
    diagnoses,
    chronicConditions,
    prescriptions,
    followups,
    feedback,
    documents,
    reviewRequests,
    adClicks,
    esignRequests,
    messages,
  ] = await Promise.all([
    admin
      .from("contact_phones")
      .select("phone_e164, label, created_at")
      .eq("org_id", orgId)
      .eq("contact_id", contactId),
    admin.from("contact_tags").select("tags(name)").eq("contact_id", contactId),
    fetchAll(
      (from, to) =>
        admin
          .from("appointments")
          .select("number, starts_at, ends_at, status, notes, source, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("starts_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("enquiries")
          .select("number, title, status, source, est_value, lost_reason, created_at, closed_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("created_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("tasks")
          .select("type, subject, notes, due_at, done, done_at, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("due_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("timeline_events")
          .select("type, actor_type, payload, at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("visits")
          .select(
            "visit_date, doctor_name, department_raw, height_cm, weight_kg, temp_c, pulse, bp_systolic, bp_diastolic, spo2, description, complaints, hpi, doctor_notes, nurse_notes, plan_of_treatment, primary_diagnosis_text",
          )
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("visit_date")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    // Phase 21: the diagnosis codes of the patient's visits and their chronic conditions (codes and dates).
    fetchAll(
      (from, to) =>
        admin
          .from("visit_diagnoses")
          .select(
            "visit_date, diagnosis_code, is_primary, source, ref_diagnoses(short_description)",
          )
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("visit_date")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("contact_chronic_conditions")
          .select("source, noted_at, last_seen_on, ref_diagnoses(code, short_description)")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("prescriptions")
          .select(
            "medication_name, class, duration_days, dosage_instruction, total_quantity, start_date",
          )
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("clinical_followups")
          .select("due_date, priority, call_status, outcome, notes, closed_at, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("clinical_feedback")
          .select("stage, score, reply_text, symptoms_reported, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("patient_documents")
          .select("title, category, mime_type, size_bytes, expires_on, scan_status, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .eq("status", "ready")
          .order("created_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    // Phase 19b: when this patient was asked for a review, which ad brought them, and their e-signature requests (no links, no e-mail).
    fetchAll(
      (from, to) =>
        admin
          .from("review_requests")
          .select("status, reason, visit_ended_at, claimed_at, created_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("created_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("ad_attributions")
          .select("source_id, source_type, headline, clicked_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("clicked_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    fetchAll(
      (from, to) =>
        admin
          .from("esign_requests")
          .select("status, signer_hint, test_mode, created_at, completed_at")
          .eq("org_id", orgId)
          .eq("contact_id", contactId)
          .order("created_at")
          .order("id")
          .range(from, to),
      { max: ROW_CAP },
    ),
    conversationIds.length
      ? fetchAll(
          (from, to) =>
            admin
              .from("messages")
              .select("conversation_id, direction, kind, body, media_filename, status, at")
              .eq("org_id", orgId)
              .in("conversation_id", conversationIds)
              .neq("direction", "note") // internal staff notes are not the patient's data
              .order("at")
              .order("id")
              .range(from, to),
          { max: MESSAGE_CAP },
        )
      : Promise.resolve({ data: [] as never[] }),
  ]);

  return {
    generated_at: new Date().toISOString(),
    contact_id: contactId,
    contact,
    phones: phones.data ?? [],
    tags: (tags.data ?? []).map((t) => t.tags?.name).filter(Boolean),
    appointments: cap("appointments", appointments),
    enquiries: cap("enquiries", enquiries),
    tasks: cap("tasks", tasks),
    conversations: conversations ?? [],
    messages: cap("messages", messages),
    timeline: cap("timeline", timeline),
    visits: cap("visits", visits),
    diagnoses: cap("diagnoses", diagnoses),
    chronic_conditions: cap("chronic_conditions", chronicConditions),
    prescriptions: cap("prescriptions", prescriptions),
    followups: cap("followups", followups),
    feedback: cap("feedback", feedback),
    // The files themselves are not part of the bundle; each is listed with its title, category, size and dates.
    documents: cap("documents", documents),
    integrations: {
      review_requests: cap("review_requests", reviewRequests),
      ad_clicks: cap("ad_clicks", adClicks),
      esign_requests: cap("esign_requests", esignRequests),
    },
    truncated,
  };
}

export { exportCounts };
