/**
 * The DB side of the clinical engine. Everything decision-like lives in the pure modules; this file
 * loads settings and visits, stores evaluations, keeps the Follow-Up Queue in step, and routes any
 * patient-facing message through the gate.
 *
 * Patient-facing clinical messages stay OFF until `clinical_messaging_enabled` is signed off: the
 * queue still fills with internal nurse / call-centre tasks, and would-be messages are logged as
 * `suppressed_gate`.
 */
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { URGENT_CATEGORIES, type TriggerCategory } from "@/lib/clinical/category";
import { mapDepartment } from "@/lib/clinical/department";
import {
  evaluateVisit,
  inputsHash,
  type EvalInput,
  type Evaluation,
  type MedClass,
} from "@/lib/clinical/evaluate";
import { evaluateRedFlag, notificationTargets, parseScore } from "@/lib/clinical/feedback";
import type { ClinicCalendar } from "@/lib/clinical/followup";
import { decideClinicalSend, type SendDecision } from "@/lib/clinical/gate";
import { composeObservationNotes, SCRUB_VERSION } from "@/lib/clinical/negation";
import { decideDay3Reply } from "@/lib/clinical/sequence";
import { ClinicalSettings, type SettingRow } from "@/lib/clinical/settings";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { createNotification, notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

type Visit = Tables<"visits">;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export async function loadClinicalSettings(
  admin: AdminClient,
  orgId: string,
): Promise<ClinicalSettings> {
  const { data } = await admin
    .from("clinical_settings")
    .select("key, approved_value, proposed_value, sign_off_status")
    .eq("org_id", orgId);
  return new ClinicalSettings((data ?? []) as SettingRow[]);
}

/** The clinic's working week and closures: the appointments booking-rule calendar. */
export async function loadCalendar(admin: AdminClient, orgId: string): Promise<ClinicCalendar> {
  const { data } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  const s = readAppointmentSettings(data?.settings);
  return { workingWeekdays: s.working_weekdays, holidays: s.holidays };
}

function toEvalInput(v: Visit, dob: string | null, classes: readonly MedClass[]): EvalInput {
  return {
    externalId: v.external_id,
    visitDate: v.visit_date,
    dob,
    departmentRaw: v.department_raw,
    doctorName: v.doctor_name,
    tempC: v.temp_c,
    pulse: v.pulse,
    bpSystolic: v.bp_systolic,
    bpDiastolic: v.bp_diastolic,
    spo2: v.spo2,
    primaryDiagnosisText: v.primary_diagnosis_text,
    secondaryDiagnosisCodes: v.secondary_diagnosis_codes,
    observationNotesRaw:
      v.observation_notes_raw ??
      composeObservationNotes({
        complaints: v.complaints,
        hpi: v.hpi,
        doctorNotes: v.doctor_notes,
        nurseNotes: v.nurse_notes,
      }),
    procedureNotes: v.procedure_notes,
    investigationsOrdered: v.investigations_ordered,
    investigationCount: v.investigation_count,
    planOfTreatment: v.plan_of_treatment,
    papResult: v.pap_result,
    symptomatic: v.symptomatic,
    prescriptionClasses: classes,
  };
}

// ---------------------------------------------------------------------------
// Evaluation + Follow-Up Queue
// ---------------------------------------------------------------------------

export type EvaluateOutcome = {
  outcome: "unchanged" | "evaluated" | "not_found";
  followUp: "created" | "existing" | "closed" | "none";
  evaluation?: Evaluation;
};

const PRIORITY: Record<"urgent" | "other", "high" | "medium"> = { urgent: "high", other: "medium" };

/**
 * Evaluates one stored visit and keeps the queue consistent:
 *  - one live follow-up per visit + category (dedupe key); re-syncs never duplicate it
 *  - a category change supersedes the old, still-untouched follow-up
 *  - rules that no longer fire close an untouched follow-up (never one a person is working on)
 * `createFollowups: false` evaluates without queueing (importing history).
 */
export async function evaluateVisitById(
  admin: AdminClient,
  orgId: string,
  visitId: string,
  opts: {
    settings?: ClinicalSettings;
    calendar?: ClinicCalendar;
    createFollowups?: boolean;
  } = {},
): Promise<EvaluateOutcome> {
  const { data: visit } = await admin
    .from("visits")
    .select("*")
    .eq("id", visitId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!visit) return { outcome: "not_found", followUp: "none" };

  const [settings, calendar, contact, rx] = await Promise.all([
    opts.settings ?? loadClinicalSettings(admin, orgId),
    opts.calendar ?? loadCalendar(admin, orgId),
    visit.contact_id
      ? admin
          .from("contacts")
          .select("dob")
          .eq("id", visit.contact_id)
          .eq("org_id", orgId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("prescriptions").select("class").eq("visit_id", visit.id).eq("org_id", orgId),
  ]);

  const input = toEvalInput(
    visit,
    contact.data?.dob ?? null,
    (rx.data ?? []).map((r) => r.class as MedClass),
  );
  const result = evaluateVisit(input, settings, calendar);
  const hash = inputsHash(input, result.settingsSnapshot);

  const { data: current } = await admin
    .from("visit_rule_evaluations")
    .select("id, inputs_hash")
    .eq("visit_id", visit.id)
    .eq("is_current", true)
    .maybeSingle();
  if (current && current.inputs_hash === hash) return { outcome: "unchanged", followUp: "none" };

  await admin
    .from("visits")
    .update({
      observation_notes_scrubbed: result.observationNotesScrubbed,
      scrub_version: result.observationNotesScrubbed === null ? null : SCRUB_VERSION,
      department_mapped: mapDepartment(visit.department_raw),
    })
    .eq("id", visit.id);

  if (current)
    await admin.from("visit_rule_evaluations").update({ is_current: false }).eq("id", current.id);
  const { data: evaluation, error } = await admin
    .from("visit_rule_evaluations")
    .insert({
      org_id: orgId,
      visit_id: visit.id,
      engine_version: result.engineVersion,
      settings_snapshot: result.settingsSnapshot as unknown as NonNullable<Json>,
      inputs_hash: hash,
      age_at_visit: result.ageAtVisit,
      department_effective: result.departmentEffective,
      vitals_complete: result.vitalsComplete,
      rules_fired: result.rulesFired,
      missing_settings: result.missingSettings,
      trigger_category: result.triggerCategory,
      follow_up_due_date: result.followUpDueDate,
      dedupe_key: result.dedupeKey,
      is_current: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`evaluation insert failed (${error.code})`);

  if (opts.createFollowups === false)
    return { outcome: "evaluated", followUp: "none", evaluation: result };

  const followUp = await syncFollowUp(admin, orgId, visit, evaluation.id, result);
  return { outcome: "evaluated", followUp, evaluation: result };
}

async function syncFollowUp(
  admin: AdminClient,
  orgId: string,
  visit: Visit,
  evaluationId: string,
  result: Evaluation,
): Promise<EvaluateOutcome["followUp"]> {
  const { data: open } = await admin
    .from("clinical_followups")
    .select("id, dedupe_key, call_status")
    .eq("org_id", orgId)
    .eq("visit_id", visit.id)
    .eq("source", "engine")
    .is("closed_at", null);
  const now = new Date().toISOString();
  const untouched = (f: { call_status: string }) => f.call_status === "pending";

  // Close what no longer applies: nothing fired, or a different category now (superseded).
  let closed = false;
  for (const f of open ?? []) {
    if (f.dedupe_key === result.dedupeKey) continue;
    if (!untouched(f)) continue; // somebody is working on it: leave it to them
    await admin
      .from("clinical_followups")
      .update({
        closed_at: now,
        closed_reason: result.triggerCategory ? "superseded" : "no_longer_triggered",
      })
      .eq("id", f.id);
    closed = true;
  }
  if (!result.triggerCategory || !result.dedupeKey) return closed ? "closed" : "none";

  const existing = (open ?? []).find((f) => f.dedupe_key === result.dedupeKey);
  if (existing) {
    await admin
      .from("clinical_followups")
      .update({ rule_evaluation_id: evaluationId })
      .eq("id", existing.id);
    return "existing";
  }
  const { error } = await admin.from("clinical_followups").insert({
    org_id: orgId,
    ref: `FU-${visit.external_id}`,
    visit_id: visit.id,
    contact_id: visit.contact_id,
    rule_evaluation_id: evaluationId,
    trigger_category: result.triggerCategory,
    priority:
      PRIORITY[
        URGENT_CATEGORIES.includes(result.triggerCategory as TriggerCategory) ? "urgent" : "other"
      ],
    due_date: result.followUpDueDate,
    dedupe_key: result.dedupeKey,
    is_test_record: visit.is_test_record,
    source: "engine",
  });
  if (error) {
    if (error.code === "23505") return "existing"; // raced with another run
    throw new Error(`follow-up insert failed (${error.code})`);
  }
  return "created";
}

/**
 * Evaluate recent visits for one org. Cheap when nothing changed (inputs hash), so it also picks up
 * newly signed settings.
 *
 * Only visits delivered by the Unite sync (`source = 'unite'`) are evaluated. History imported from
 * Airtable (`source = 'airtable'`) was already evaluated and worked there; re-evaluating a recent
 * imported visit would raise a NEW open follow-up even when its Airtable follow-up is closed.
 */
export async function evaluateRecentVisits(
  admin: AdminClient,
  orgId: string,
  opts: { sinceDays?: number; limit?: number; createFollowups?: boolean } = {},
): Promise<{ checked: number; evaluated: number; created: number }> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: visits } = await admin
    .from("visits")
    .select("id")
    .eq("org_id", orgId)
    .eq("source", "unite")
    .gte("visit_date", since)
    .order("visit_date", { ascending: false })
    .limit(opts.limit ?? 500);
  const settings = await loadClinicalSettings(admin, orgId);
  const calendar = await loadCalendar(admin, orgId);
  const totals = { checked: 0, evaluated: 0, created: 0 };
  for (const v of visits ?? []) {
    totals.checked++;
    const r = await evaluateVisitById(admin, orgId, v.id, {
      settings,
      calendar,
      createFollowups: opts.createFollowups,
    });
    if (r.outcome === "evaluated") totals.evaluated++;
    if (r.followUp === "created") totals.created++;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Messages (gated)
// ---------------------------------------------------------------------------

export type DispatchResult =
  | {
      ok: true;
      status: SendDecision["status"] | "duplicate";
      logId: string;
      messageId?: string;
      reason: string;
    }
  | { ok: false; error: string };

/**
 * Every patient-facing clinical message goes through here. The decision (gate, template approval,
 * consent, test/live mode) is recorded in clinical_message_log whether or not anything is sent, and
 * the idempotency key makes a repeat call a no-op (a re-synced visit never double-sends).
 */
export async function dispatchClinicalMessage(
  admin: AdminClient,
  o: {
    orgId: string;
    templateKey: string;
    contactId: string;
    idempotencyKey: string;
    values?: Record<string, string>;
    visitId?: string | null;
    prescriptionId?: string | null;
    followupId?: string | null;
    triggerCategory?: TriggerCategory | null;
    settings?: ClinicalSettings;
  },
): Promise<DispatchResult> {
  const { data: dup } = await admin
    .from("clinical_message_log")
    .select("id, status")
    .eq("org_id", o.orgId)
    .eq("idempotency_key", o.idempotencyKey)
    .maybeSingle();
  if (dup) return { ok: true, status: "duplicate", logId: dup.id, reason: "already_logged" };

  const settings = o.settings ?? (await loadClinicalSettings(admin, o.orgId));
  const [{ data: contact }, { data: tpl }] = await Promise.all([
    admin
      .from("contacts")
      .select("id, phone_e164, wa_bsuid, is_test_record, clinical_messaging_consent")
      .eq("id", o.contactId)
      .eq("org_id", o.orgId)
      .maybeSingle(),
    admin
      .from("wa_templates")
      .select("id, name, status, components, channel_id, waba_id, clinical_approval")
      .eq("org_id", o.orgId)
      .eq("internal_key", o.templateKey)
      .maybeSingle(),
  ]);
  if (!contact) return { ok: false, error: "Contact not found." };

  const sendMode = settings.value("recall_send_mode") === "live" ? "live" : "test"; // unsigned → test
  const decision = decideClinicalSend({
    gateEnabled: settings.messagingEnabled(),
    sendMode,
    contactIsTestRecord: contact.is_test_record,
    templateApproved: !!tpl && tpl.clinical_approval === "approved" && tpl.status === "APPROVED",
    hasConsent: contact.clinical_messaging_consent,
  });

  const { data: log, error } = await admin
    .from("clinical_message_log")
    .insert({
      org_id: o.orgId,
      template_key: o.templateKey,
      wa_template_id: tpl?.id ?? null,
      trigger_category: o.triggerCategory ?? null,
      idempotency_key: o.idempotencyKey,
      contact_id: o.contactId,
      visit_id: o.visitId ?? null,
      prescription_id: o.prescriptionId ?? null,
      followup_id: o.followupId ?? null,
      send_mode: sendMode,
      status: decision.allow
        ? "scheduled"
        : decision.status === "send"
          ? "scheduled"
          : decision.status,
      block_reason: decision.allow ? null : decision.reason,
      scheduled_at: new Date().toISOString(),
      is_test_record: contact.is_test_record,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505")
      return { ok: true, status: "duplicate", logId: "", reason: "raced" };
    return { ok: false, error: `Could not log the message (${error.code}).` };
  }
  if (!decision.allow)
    return { ok: true, status: decision.status, logId: log.id, reason: decision.reason };

  // Allowed: queue through the normal outbound path (rate limit + window guard apply there).
  if (!tpl) return { ok: false, error: "Template missing." };
  const { data: channels } = await admin
    .from("channels")
    .select("id")
    .eq("org_id", o.orgId)
    .eq("status", "active")
    .eq("waba_id", tpl.waba_id);
  const channelId = (channels ?? []).find((c) => c.id === tpl.channel_id)?.id ?? channels?.[0]?.id;
  if (!channelId) {
    await admin
      .from("clinical_message_log")
      .update({ status: "blocked", block_reason: "no_active_channel" })
      .eq("id", log.id);
    return { ok: true, status: "blocked", logId: log.id, reason: "no_active_channel" };
  }
  const components = tpl.components as unknown as MetaTemplateComponent[];
  const values = o.values ?? {};
  const preview = renderTemplatePreview(components, values);
  if (preview.missing.length) {
    await admin
      .from("clinical_message_log")
      .update({ status: "blocked", block_reason: "template_variables_missing" })
      .eq("id", log.id);
    return { ok: true, status: "blocked", logId: log.id, reason: "template_variables_missing" };
  }
  const conversation = await ensureConversation(admin, o.orgId, o.contactId, channelId);
  const message = await queueOutbound(admin, {
    orgId: o.orgId,
    conversationId: conversation.id,
    spec: { type: "template", template_id: tpl.id, values },
    body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
    sentByUserId: null,
    priority: false,
  });
  await admin
    .from("clinical_message_log")
    .update({ status: "sent", sent_at: new Date().toISOString(), message_id: message.id })
    .eq("id", log.id);
  return { ok: true, status: "send", logId: log.id, messageId: message.id, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Feedback replies: scores, red flags, dual notification
// ---------------------------------------------------------------------------

export type FeedbackStage =
  "day3_antibiotics" | "after_antibiotics" | "after_probiotics" | "post_procedure";

/**
 * Stores a feedback reply (raw text verbatim, parsed score or null) and applies the red-flag rule.
 * On a red flag the treating doctor AND the care coordinators are both notified and a High follow-up
 * is raised; the two notification stamps are written together (DB constraint). A reply that could not
 * be evaluated (unsigned threshold / keywords, or no score) goes to a person without an alert.
 */
export async function recordFeedback(
  admin: AdminClient,
  o: {
    orgId: string;
    contactId: string;
    stage: FeedbackStage;
    replyText: string;
    visitId?: string | null;
    prescriptionId?: string | null;
    sourceMessageId?: string | null;
    settings?: ClinicalSettings;
    /** Callers that raise their own follow-up (the day-3 flow) pass false to avoid a duplicate. */
    createFollowUp?: boolean;
  },
): Promise<{
  feedbackId: string;
  redFlag: boolean;
  needsHumanReview: boolean;
  score: number | null;
  flag: ReturnType<typeof evaluateRedFlag>;
}> {
  const settings = o.settings ?? (await loadClinicalSettings(admin, o.orgId));
  const score = parseScore(o.replyText);
  const flag = evaluateRedFlag({ score, text: o.replyText }, settings);

  const { data: contact } = await admin
    .from("contacts")
    .select("is_test_record")
    .eq("id", o.contactId)
    .eq("org_id", o.orgId)
    .maybeSingle();
  const { data: row, error } = await admin
    .from("clinical_feedback")
    .insert({
      org_id: o.orgId,
      contact_id: o.contactId,
      visit_id: o.visitId ?? null,
      prescription_id: o.prescriptionId ?? null,
      stage: o.stage,
      score,
      reply_text: o.replyText,
      side_effects_flagged: flag.keywordFlag,
      needs_doctor_review: flag.needsHumanReview,
      red_flag_threshold_used: flag.thresholdUsed,
      source_message_id: o.sourceMessageId ?? null,
      is_test_record: contact?.is_test_record ?? false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`feedback insert failed (${error.code})`);

  if (flag.needsHumanReview && o.createFollowUp !== false) {
    const priority = flag.redFlag ? "high" : "medium";
    const key = `feedback-${row.id}`;
    await admin.from("clinical_followups").insert({
      org_id: o.orgId,
      ref: `FB-${row.id.slice(0, 8)}`,
      visit_id: o.visitId ?? null,
      contact_id: o.contactId,
      prescription_id: o.prescriptionId ?? null,
      priority,
      due_date: new Date().toISOString().slice(0, 10),
      doctor_alert_required: flag.redFlag,
      notes: flag.redFlag
        ? `Red flag (${[flag.scoreFlag && "low score", flag.keywordFlag && `side effect: ${flag.keywordsHit.join(", ")}`].filter(Boolean).join("; ")}).`
        : `Reply could not be evaluated automatically (${score === null ? "no score" : flag.missingSettings.join(", ") || "review"}).`,
      dedupe_key: key,
      is_test_record: contact?.is_test_record ?? false,
      source: "feedback",
    });
  }

  if (flag.redFlag) {
    const targets = notificationTargets(flag);
    const title = "Clinical red flag in a patient reply";
    const payload = { feedback_id: row.id, contact_id: o.contactId } as Json;
    // Both parties, always: neither is skipped because the other succeeded.
    if (targets.doctor) {
      const doctorId = await treatingDoctorUserId(admin, o.orgId, o.visitId ?? null);
      if (doctorId)
        await createNotification(admin, {
          orgId: o.orgId,
          userId: doctorId,
          type: "clinical.red_flag",
          title,
          body: "Please review the patient reply in the Follow-Up Queue.",
          payload,
        });
    }
    if (targets.coordinator)
      await notifyMembersWithPermission(admin, o.orgId, "portal.clinical_followups.write", {
        type: "clinical.red_flag",
        title,
        body: "A patient reply needs a call. See the Follow-Up Queue.",
        payload,
      });
    const stamp = new Date().toISOString();
    await admin
      .from("clinical_feedback")
      .update({ doctor_notified_at: stamp, coordinator_notified_at: stamp })
      .eq("id", row.id);
  }
  return {
    feedbackId: row.id,
    redFlag: flag.redFlag,
    needsHumanReview: flag.needsHumanReview,
    score,
    flag,
  };
}

async function treatingDoctorUserId(
  admin: AdminClient,
  orgId: string,
  visitId: string | null,
): Promise<string | null> {
  if (!visitId) return null;
  const { data } = await admin
    .from("visits")
    .select("specialists(user_id)")
    .eq("id", visitId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data?.specialists?.user_id ?? null;
}

/**
 * A reply to the day-3 check: store it, apply the HALT rule and move the sequence on. Halting
 * alerts the doctor and raises a High follow-up; the PROBIOTIC_START template is then never sent
 * (canSendProbiotic). Nothing here sends a message: the caller dispatches ABX_UNWELL through the gate.
 */
export async function applyDay3Reply(
  admin: AdminClient,
  o: {
    orgId: string;
    prescriptionId: string;
    replyText: string;
    settings?: ClinicalSettings;
  },
) {
  const settings = o.settings ?? (await loadClinicalSettings(admin, o.orgId));
  const { data: rx } = await admin
    .from("prescriptions")
    .select("id, visit_id, contact_id, is_test_record")
    .eq("id", o.prescriptionId)
    .eq("org_id", o.orgId)
    .maybeSingle();
  if (!rx || !rx.contact_id) return { ok: false as const, error: "Prescription not found." };

  const score = parseScore(o.replyText);
  const decision = decideDay3Reply({ score }, settings);
  await admin
    .from("prescription_sequences")
    .update({
      status: decision.status,
      day3_score: score,
      ...(decision.action === "halt"
        ? { halted_at: new Date().toISOString(), halted_reason: decision.reason }
        : {}),
    })
    .eq("prescription_id", rx.id)
    .eq("org_id", o.orgId);

  const fb = await recordFeedback(admin, {
    orgId: o.orgId,
    contactId: rx.contact_id,
    stage: "day3_antibiotics",
    replyText: o.replyText,
    visitId: rx.visit_id,
    prescriptionId: rx.id,
    settings,
    createFollowUp: false,
  });

  // A person owns anything the engine can't settle on its own: a halt, an unclear reply, or a red flag.
  if (decision.humanTask || fb.needsHumanReview) {
    const high = decision.followUpPriority === "high" || fb.redFlag;
    const { error } = await admin.from("clinical_followups").insert({
      org_id: o.orgId,
      ref: `SEQ-${rx.id.slice(0, 8)}`,
      visit_id: rx.visit_id,
      contact_id: rx.contact_id,
      prescription_id: rx.id,
      priority: high ? "high" : "medium",
      due_date: new Date().toISOString().slice(0, 10),
      doctor_alert_required: decision.alertDoctor || fb.redFlag,
      notes: `Day-3 check: ${decision.reason.replace(/_/g, " ")}.`,
      dedupe_key: `day3-${rx.id}`,
      is_test_record: rx.is_test_record,
      source: "sequence",
    });
    if (error && error.code !== "23505") throw new Error(`follow-up insert failed (${error.code})`);
  }
  return { ok: true as const, decision, score };
}
