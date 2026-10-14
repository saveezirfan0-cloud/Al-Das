/**
 * Antibiotic / probiotic sequences, database side (Phase 21; rules R-13 .. R-17).
 *
 *  - planPendingSequences(): every antibiotic prescription from the live Unite feed without a sequence gets
 *    one (planSequence), and its steps become scheduled_jobs rows (kind `clinical.sequence_step`) written in
 *    the same transaction by public.clinical_create_sequence(): created once, never scheduled twice.
 *  - processSequenceStep(): runs one due step from the `clinical` queue. The step's own rule decides whether
 *    it may still act (decideSequenceStep); every patient-facing message then goes through
 *    dispatchClinicalMessage, i.e. the clinical messaging gate. While the gate is OFF nothing is sent: the
 *    would-send is logged as `suppressed_gate` and the step records "skipped_gate_off".
 *
 * Steps whose day has passed are skipped, never sent late. Imported history is never sequenced.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { loadClinicalSettings, dispatchClinicalMessage } from "@/lib/clinical/engine";
import {
  decideSequenceStep,
  planSequence,
  sequenceSchedule,
  type SequenceStatus,
  type SequenceStep,
} from "@/lib/clinical/sequence";
import type { ClinicalSettings } from "@/lib/clinical/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Local clinic time at which a step's message is queued on its day. An operational choice (inside opening
 * hours), not a clinical threshold; the outbound queue's rate limit and window guard still apply.
 */
export const SEQUENCE_STEP_LOCAL_TIME = "10:00:00";

export async function orgTimezone(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  return data?.timezone || "Asia/Dubai";
}

export type PlanResult = {
  checked: number;
  created: number;
  scheduled: number;
  durationMissing: number;
  stepsSkippedPast: number;
};

/** Create sequences (and their scheduled steps) for antibiotic prescriptions that have none. Idempotent. */
export async function planPendingSequences(
  admin: AdminClient,
  orgId: string,
  opts: { limit?: number; now?: Date; settings?: ClinicalSettings; timezone?: string } = {},
): Promise<PlanResult> {
  const totals: PlanResult = {
    checked: 0,
    created: 0,
    scheduled: 0,
    durationMissing: 0,
    stepsSkippedPast: 0,
  };
  const { data: pending, error } = await admin.rpc("clinical_prescriptions_needing_sequence", {
    p_org: orgId,
    p_limit: opts.limit ?? 200,
  });
  if (error) throw new Error(`sequence sweep failed (${error.code ?? "unknown"})`);
  if (!pending?.length) return totals;

  const settings = opts.settings ?? (await loadClinicalSettings(admin, orgId));
  const tz = opts.timezone ?? (await orgTimezone(admin, orgId));
  const today = formatInTimeZone(opts.now ?? new Date(), tz, "yyyy-MM-dd");

  for (const rx of pending) {
    totals.checked++;
    const plan = planSequence(
      {
        drugClass: "antibiotic",
        startDate: (rx.start_date as string | null) ?? null,
        durationDays: (rx.duration_days as number | null) ?? null,
        requiresProbiotics: rx.requires_probiotics === true,
      },
      settings,
    );
    const { steps, skipped } = sequenceSchedule(plan, today);
    totals.stepsSkippedPast += skipped.filter((s) => s.reason === "date_passed").length;
    const { data: res, error: createError } = await admin.rpc("clinical_create_sequence", {
      p_org: orgId,
      p_prescription: rx.prescription_id,
      p_sequence: {
        requires_probiotics: rx.requires_probiotics === true,
        probiotic_duration_days: plan.probioticEndDate
          ? (settings.num("probiotic_default_days") ?? null)
          : null,
        day3_offset_days: plan.day3CheckDate ? (settings.num("day3_offset_days") ?? null) : null,
        antibiotic_end_date: plan.endDate,
        day3_check_date: plan.day3CheckDate,
        probiotic_start_date: plan.probioticStartDate,
        probiotic_end_date: plan.probioticEndDate,
      },
      p_steps: steps.map((s) => ({
        step: s.step,
        run_at: fromZonedTime(`${s.date}T${SEQUENCE_STEP_LOCAL_TIME}`, tz).toISOString(),
      })),
    });
    if (createError) throw new Error(`sequence create failed (${createError.code ?? "unknown"})`);
    const r = (res ?? {}) as { created?: boolean; scheduled?: number };
    if (!r.created) continue;
    totals.created++;
    totals.scheduled += Number(r.scheduled ?? 0);

    // BC-22: an antibiotic with no duration gets no dates; a person is told (internal task, no patient message).
    if (plan.notes.includes("duration_missing")) {
      totals.durationMissing++;
      const { data: p } = await admin
        .from("prescriptions")
        .select("id, visit_id, contact_id, is_test_record")
        .eq("id", rx.prescription_id)
        .eq("org_id", orgId)
        .maybeSingle();
      if (p) {
        const { error: fuError } = await admin.from("clinical_followups").insert({
          org_id: orgId,
          ref: `RX-${p.id.slice(0, 8)}`,
          visit_id: p.visit_id,
          contact_id: p.contact_id,
          prescription_id: p.id,
          priority: "medium",
          due_date: today,
          notes:
            "Antibiotic prescription without a start date or duration: the day-3 check and probiotic hand-over could not be planned.",
          dedupe_key: `rx-duration-${p.id}`,
          is_test_record: p.is_test_record,
          source: "sequence",
        });
        if (fuError && fuError.code !== "23505")
          throw new Error(`follow-up insert failed (${fuError.code})`);
      }
    }
  }
  return totals;
}

export type StepOutcome =
  | "sent"
  | "skipped_gate_off"
  | "suppressed_test_record"
  | "blocked"
  | "duplicate"
  | "skipped_status"
  | "skipped_no_patient"
  | "nurse_task"
  | "not_found";

/** Runs one due step. Safe to repeat: the message idempotency key and the status checks decide. */
export async function processSequenceStep(
  admin: AdminClient,
  o: { orgId: string; sequenceId: string; step: SequenceStep },
  now: Date = new Date(),
): Promise<{ outcome: StepOutcome; reason: string }> {
  const { data: seq } = await admin
    .from("prescription_sequences")
    .select("id, status, antibiotic_end_date, prescription_id, step_outcomes")
    .eq("id", o.sequenceId)
    .eq("org_id", o.orgId)
    .maybeSingle();
  if (!seq) return { outcome: "not_found", reason: "sequence_not_found" };
  const { data: rx } = await admin
    .from("prescriptions")
    .select("id, external_key, contact_id, visit_id, is_test_record")
    .eq("id", seq.prescription_id)
    .eq("org_id", o.orgId)
    .maybeSingle();

  const record = async (outcome: StepOutcome, reason: string) => {
    const prev = (seq.step_outcomes ?? {}) as Record<string, Json>;
    await admin
      .from("prescription_sequences")
      .update({
        step_outcomes: { ...prev, [o.step]: { outcome, reason, at: now.toISOString() } },
      })
      .eq("id", seq.id)
      .eq("org_id", o.orgId);
    return { outcome, reason };
  };

  if (!rx) return record("not_found", "prescription_not_found");
  const tz = await orgTimezone(admin, o.orgId);
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const decision = decideSequenceStep(
    o.step,
    { status: seq.status as SequenceStatus, endDate: seq.antibiotic_end_date },
    today,
  );
  if (decision.action === "skip") return record("skipped_status", decision.reason);

  if (decision.action === "nurse_task") {
    // R-17: silence is never read as improvement. Internal task only, so the messaging gate does not apply.
    const { error } = await admin.from("clinical_followups").insert({
      org_id: o.orgId,
      ref: `SEQ-${rx.id.slice(0, 8)}`,
      visit_id: rx.visit_id,
      contact_id: rx.contact_id,
      prescription_id: rx.id,
      priority: "medium",
      due_date: today,
      notes:
        "No reply to the day-3 check by the end of the antibiotic course: please call the patient.",
      dedupe_key: `noreply-${rx.id}`,
      is_test_record: rx.is_test_record,
      source: "sequence",
    });
    if (error && error.code !== "23505") throw new Error(`follow-up insert failed (${error.code})`);
    return record("nurse_task", decision.reason);
  }

  if (!rx.contact_id) return record("skipped_no_patient", "prescription_has_no_patient");
  const settings = await loadClinicalSettings(admin, o.orgId);
  const res = await dispatchClinicalMessage(admin, {
    orgId: o.orgId,
    templateKey: decision.templateKey,
    contactId: rx.contact_id,
    // The audit's scheme: "<prescription external key>:<template key>" (also blocks a later re-send).
    idempotencyKey: `${rx.external_key}:${decision.templateKey}`,
    prescriptionId: rx.id,
    visitId: rx.visit_id,
    settings,
  });
  if (!res.ok) throw new Error(res.error);
  switch (res.status) {
    case "send": {
      // Move forward only from the status the decision was taken on (a reply may have moved it meanwhile).
      await admin
        .from("prescription_sequences")
        .update({ status: decision.nextStatus })
        .eq("id", seq.id)
        .eq("org_id", o.orgId)
        .eq("status", seq.status);
      return record("sent", "ok");
    }
    case "suppressed_gate":
      return record("skipped_gate_off", res.reason);
    case "suppressed_test_record":
      return record("suppressed_test_record", res.reason);
    case "duplicate":
      return record("duplicate", res.reason);
    default:
      return record("blocked", res.reason);
  }
}
