import { addDays } from "@/lib/clinical/followup";
import type { MedClass } from "@/lib/clinical/evaluate";
import { ClinicalSettings, Needs } from "@/lib/clinical/settings";

export type SequenceStatus =
  | "not_started"
  | "day3_sent"
  | "awaiting_day3_reply"
  | "awaiting_clarification"
  | "awaiting_probiotic"
  | "probiotic_sent"
  | "outcome_sent"
  | "complete"
  | "halted_clinical";

export type SequencePlan = {
  /** Only antibiotics start a sequence. Steroids, unclassified and everything else: no (TP-19). */
  applicable: boolean;
  endDate: string | null;
  day3CheckDate: string | null;
  probioticStartDate: string | null;
  probioticEndDate: string | null;
  notes: string[];
  missingSettings: string[];
};

/**
 * R-13…R-15 dates for one prescription. A 7-day course starting 1 Mar ends 7 Mar (day 7, not day 8).
 * No duration → no dates at all and a note for the queue (BC-22).
 */
export function planSequence(
  rx: {
    drugClass: MedClass;
    startDate: string | null;
    durationDays: number | null;
    requiresProbiotics: boolean;
    probioticDaysOverride?: number | null;
  },
  settings: ClinicalSettings,
): SequencePlan {
  const plan: SequencePlan = {
    applicable: rx.drugClass === "antibiotic",
    endDate: null,
    day3CheckDate: null,
    probioticStartDate: null,
    probioticEndDate: null,
    notes: [],
    missingSettings: [],
  };
  if (!plan.applicable) return plan;

  if (!rx.startDate || rx.durationDays === null || !(rx.durationDays > 0)) {
    plan.notes.push("duration_missing");
    return plan;
  }
  const need = new Needs(settings);
  plan.endDate = addDays(rx.startDate, rx.durationDays - 1);

  const offset = need.num("day3_offset_days");
  if (offset !== undefined) plan.day3CheckDate = addDays(rx.startDate, offset);

  if (rx.requiresProbiotics) {
    const days = rx.probioticDaysOverride ?? need.num("probiotic_default_days");
    plan.probioticStartDate = addDays(plan.endDate, 1);
    if (days !== undefined && days > 0)
      plan.probioticEndDate = addDays(plan.probioticStartDate, days - 1);
  }
  plan.missingSettings = [...need.missing].sort();
  return plan;
}

export type Day3Decision = {
  action: "halt" | "continue" | "clarify" | "human_review";
  status: SequenceStatus;
  /** Template to send now, if any. */
  sendTemplate: "ABX_UNWELL" | null;
  alertDoctor: boolean;
  followUpPriority: "high" | "medium" | null;
  /** A person must look at it (nothing is sent automatically). */
  humanTask: boolean;
  reason: string;
};

/**
 * R-14 / R-16: what a reply to the day-3 check means.
 *  - no readable 1–10 score → raw text kept, "awaiting clarification", human task, nothing guessed
 *  - score at or below the HALT threshold → ABX_UNWELL, halted, doctor alerted, High queue item
 *  - score above it → awaiting probiotic
 *  - HALT threshold not signed off → every reply goes to a human (BC-23)
 */
export function decideDay3Reply(
  reply: { score: number | null },
  settings: ClinicalSettings,
): Day3Decision {
  if (reply.score === null)
    return {
      action: "clarify",
      status: "awaiting_clarification",
      sendTemplate: null,
      alertDoctor: false,
      followUpPriority: "medium",
      humanTask: true,
      reason: "unparseable_reply",
    };
  const halt = settings.num("day3_halt_threshold");
  if (halt === undefined)
    return {
      action: "human_review",
      status: "awaiting_clarification",
      sendTemplate: null,
      alertDoctor: false,
      followUpPriority: "medium",
      humanTask: true,
      reason: "halt_threshold_not_signed_off",
    };
  if (reply.score <= halt)
    return {
      action: "halt",
      status: "halted_clinical",
      sendTemplate: "ABX_UNWELL",
      alertDoctor: true,
      followUpPriority: "high",
      humanTask: true,
      reason: "score_at_or_below_halt_threshold",
    };
  return {
    action: "continue",
    status: "awaiting_probiotic",
    sendTemplate: null,
    alertDoctor: false,
    followUpPriority: null,
    humanTask: false,
    reason: "score_above_halt_threshold",
  };
}

/** R-15: PROBIOTIC_START must never go on date alone — never for a halted or unclear patient. */
export function canSendProbiotic(status: SequenceStatus): boolean {
  return status !== "halted_clinical" && status !== "awaiting_clarification";
}

// ---------------------------------------------------------------------------
// Phase 21: scheduling the sequence (one scheduled_jobs row per step)
// ---------------------------------------------------------------------------

/** The patient-facing steps carry a template key; NO_REPLY_CHECK is internal (a nurse call task). */
export type SequenceStep = "ABX_DAY3" | "NO_REPLY_CHECK" | "PROBIOTIC_START" | "TREATMENT_OUTCOME";
export const SEQUENCE_STEPS: readonly SequenceStep[] = [
  "ABX_DAY3",
  "NO_REPLY_CHECK",
  "PROBIOTIC_START",
  "TREATMENT_OUTCOME",
];
export const STEP_TEMPLATE: Record<SequenceStep, string | null> = {
  ABX_DAY3: "ABX_DAY3",
  NO_REPLY_CHECK: null,
  PROBIOTIC_START: "PROBIOTIC_START",
  TREATMENT_OUTCOME: "TREATMENT_OUTCOME",
};

export type PlannedStep = { step: SequenceStep; date: string };
export type StepSkip = { step: SequenceStep; reason: "no_date" | "date_passed" };

/**
 * Which steps to schedule for a plan, on which local day. A step with no date (an unsigned setting, no
 * probiotics, no duration) is not scheduled; a step whose day has already passed is skipped, never sent
 * late (the same rule as appointment reminders). Today itself still counts.
 */
export function sequenceSchedule(
  plan: SequencePlan,
  today: string,
): { steps: PlannedStep[]; skipped: StepSkip[] } {
  const steps: PlannedStep[] = [];
  const skipped: StepSkip[] = [];
  if (!plan.applicable) return { steps, skipped };
  const dates: Record<SequenceStep, string | null> = {
    ABX_DAY3: plan.day3CheckDate,
    NO_REPLY_CHECK: plan.endDate ? addDays(plan.endDate, 1) : null,
    PROBIOTIC_START: plan.probioticStartDate,
    TREATMENT_OUTCOME: plan.probioticEndDate,
  };
  for (const step of SEQUENCE_STEPS) {
    const date = dates[step];
    if (!date) skipped.push({ step, reason: "no_date" });
    else if (date < today) skipped.push({ step, reason: "date_passed" });
    else steps.push({ step, date });
  }
  return { steps, skipped };
}

export type StepDecision =
  | { action: "dispatch"; templateKey: string; nextStatus: SequenceStatus }
  | { action: "nurse_task"; reason: string }
  | { action: "skip"; reason: string };

/**
 * What a due step may do, given the sequence's status now. The clinical messaging gate is applied
 * afterwards by dispatchClinicalMessage (decideClinicalSend): with the gate off a "dispatch" only logs
 * a suppressed would-send row and the status does not move.
 */
export function decideSequenceStep(
  step: SequenceStep,
  seq: { status: SequenceStatus; endDate: string | null },
  today: string,
): StepDecision {
  switch (step) {
    case "ABX_DAY3":
      return seq.status === "not_started"
        ? { action: "dispatch", templateKey: "ABX_DAY3", nextStatus: "awaiting_day3_reply" }
        : { action: "skip", reason: `status_${seq.status}` };
    case "NO_REPLY_CHECK": {
      const r = noReplyCheck(seq, today);
      return r.raiseNurseCallTask
        ? { action: "nurse_task", reason: "no_reply_by_end_date" }
        : { action: "skip", reason: "not_waiting_for_a_reply" };
    }
    case "PROBIOTIC_START":
      if (!canSendProbiotic(seq.status)) return { action: "skip", reason: `status_${seq.status}` };
      if (["probiotic_sent", "outcome_sent", "complete"].includes(seq.status))
        return { action: "skip", reason: `status_${seq.status}` };
      return { action: "dispatch", templateKey: "PROBIOTIC_START", nextStatus: "probiotic_sent" };
    case "TREATMENT_OUTCOME":
      return seq.status === "probiotic_sent"
        ? { action: "dispatch", templateKey: "TREATMENT_OUTCOME", nextStatus: "outcome_sent" }
        : { action: "skip", reason: `status_${seq.status}` };
  }
}

/**
 * R-17: no reply by the antibiotic end date. The sequence proceeds, but silence is never read as
 * improvement: a nurse call task is raised.
 */
export function noReplyCheck(
  seq: { status: SequenceStatus; endDate: string | null },
  today: string,
): { proceed: boolean; raiseNurseCallTask: boolean } {
  const silent = seq.status === "day3_sent" || seq.status === "awaiting_day3_reply";
  const past = seq.endDate !== null && today > seq.endDate;
  return { proceed: true, raiseNurseCallTask: silent && past };
}
