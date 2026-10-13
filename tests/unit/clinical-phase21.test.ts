/**
 * Phase 21 pure rules: chronic conditions from visit diagnoses, diagnosis-code ingest, the sequence schedule and
 * step decisions, and the medication-class suggestion. Synthetic ids and dates only.
 */
import { describe, expect, it } from "vitest";

import {
  CHRONIC_MIN_VISITS_KEY,
  deriveChronicConditions,
  toApplyRows,
  type ChronicDiagnosisFact,
} from "@/lib/clinical/chronic";
import { ingestDiagnosisCodes } from "@/lib/clinical/ingest";
import { suggestMedicationClass } from "@/lib/clinical/medication-class";
import { decideSequenceStep, planSequence, sequenceSchedule } from "@/lib/clinical/sequence";
import { ClinicalSettings } from "@/lib/clinical/settings";
import { settingsWithUnsigned, signedSettings } from "@/lib/clinical/test-support";

const fact = (over: Partial<ChronicDiagnosisFact> = {}): ChronicDiagnosisFact => ({
  contactId: "c-1",
  refDiagnosisId: "d-htn",
  chronic: true,
  visitCount: 1,
  firstVisitDate: "2026-01-10",
  lastVisitDate: "2026-01-10",
  ...over,
});

describe("chronic conditions from visit diagnoses", () => {
  it("fails closed while the threshold is not signed off: nothing is derived", () => {
    const unsigned = settingsWithUnsigned(
      [],
      [
        {
          key: CHRONIC_MIN_VISITS_KEY,
          approved_value: null,
          proposed_value: "1",
          sign_off_status: "awaiting",
        },
      ],
    );
    const r = deriveChronicConditions([fact()], unsigned);
    expect(r.conditions).toEqual([]);
    expect(r.missingSettings).toEqual([CHRONIC_MIN_VISITS_KEY]);
    // missing row entirely
    expect(deriveChronicConditions([fact()], new ClinicalSettings([])).conditions).toEqual([]);
  });

  it("uses the proposed value only when unsigned defaults are signed off for internal validation", () => {
    const s = new ClinicalSettings([
      {
        key: CHRONIC_MIN_VISITS_KEY,
        approved_value: null,
        proposed_value: "1",
        sign_off_status: "awaiting",
      },
      {
        key: "allow_unsigned_defaults",
        approved_value: "true",
        proposed_value: "true",
        sign_off_status: "approved",
      },
    ]);
    expect(deriveChronicConditions([fact()], s).conditions).toHaveLength(1);
  });

  it("refuses a threshold that is not a whole number of at least 1", () => {
    for (const v of ["0", "-1", "1.5", "abc"]) {
      const r = deriveChronicConditions([fact()], signedSettings({ [CHRONIC_MIN_VISITS_KEY]: v }));
      expect(r.conditions, v).toEqual([]);
      expect(r.missingSettings, v).toEqual([CHRONIC_MIN_VISITS_KEY]);
    }
  });

  it("derives a chronic-flagged diagnosis once it reaches the minimum number of visits", () => {
    const s = signedSettings({ [CHRONIC_MIN_VISITS_KEY]: 2 });
    const r = deriveChronicConditions(
      [
        fact({
          contactId: "c-1",
          visitCount: 2,
          firstVisitDate: "2025-11-02",
          lastVisitDate: "2026-02-01",
        }),
        fact({ contactId: "c-2", visitCount: 1 }),
      ],
      s,
    );
    expect(r.conditions).toEqual([
      {
        contactId: "c-1",
        refDiagnosisId: "d-htn",
        notedAt: "2025-11-02",
        lastSeenOn: "2026-02-01",
        evidenceVisits: 2,
      },
    ]);
    expect(r.skipped.below_min_visits).toBe(1);
  });

  it("never derives from unknown, blank or non-chronic data", () => {
    const s = signedSettings({ [CHRONIC_MIN_VISITS_KEY]: 1 });
    const r = deriveChronicConditions(
      [
        fact({ contactId: null }),
        fact({ contactId: "  " }),
        fact({ refDiagnosisId: null }),
        fact({ chronic: null }),
        fact({ chronic: false }),
        fact({ visitCount: null }),
        fact({ visitCount: 0 }),
        fact({ lastVisitDate: null }),
        fact({ firstVisitDate: "01/02/2026" }),
      ],
      s,
    );
    expect(r.conditions).toEqual([]);
    expect(r.skipped).toEqual({
      no_patient: 2,
      unknown_code: 1,
      chronic_flag_unknown: 1,
      not_chronic: 1,
      no_visit_date: 4,
    });
  });

  it("merges duplicate facts and returns a stable order for the writer", () => {
    const s = signedSettings({ [CHRONIC_MIN_VISITS_KEY]: 2 });
    const r = deriveChronicConditions(
      [
        fact({ contactId: "c-2", refDiagnosisId: "d-b", visitCount: 2 }),
        fact({
          contactId: "c-1",
          refDiagnosisId: "d-z",
          visitCount: 1,
          firstVisitDate: "2026-03-01",
          lastVisitDate: "2026-03-01",
        }),
        fact({
          contactId: "c-1",
          refDiagnosisId: "d-z",
          visitCount: 1,
          firstVisitDate: "2026-01-01",
          lastVisitDate: "2026-01-01",
        }),
      ],
      s,
    );
    expect(r.conditions.map((x) => `${x.contactId}/${x.refDiagnosisId}`)).toEqual([
      "c-1/d-z",
      "c-2/d-b",
    ]);
    expect(r.conditions[0]).toMatchObject({
      notedAt: "2026-01-01",
      lastSeenOn: "2026-03-01",
      evidenceVisits: 2,
    });
    expect(toApplyRows(r.conditions)[0]).toEqual({
      contact_id: "c-1",
      ref_diagnosis_id: "d-z",
      noted_at: "2026-01-01",
      last_seen_on: "2026-03-01",
      evidence_visits: 2,
    });
  });
});

describe("diagnosis codes at ingest", () => {
  it("normalises, de-duplicates (primary wins), adds the primary and drops non-ICD values", () => {
    const r = ingestDiagnosisCodes({
      primary: " e11.9 ",
      codes: ["I10", "i10", "E11.9", "", null, "hypertension", "S72.001A", "E119", "Z00.00"],
    });
    expect(r.diagnoses).toEqual([
      { code: "E11.9", isPrimary: true },
      { code: "I10", isPrimary: false },
      { code: "S72.001A", isPrimary: false },
      { code: "E119", isPrimary: false },
      { code: "Z00.00", isPrimary: false },
    ]);
    expect(r.rejected).toBe(1);
    expect(ingestDiagnosisCodes({}).diagnoses).toEqual([]);
  });
});

describe("antibiotic sequence schedule", () => {
  const rx = {
    drugClass: "antibiotic" as const,
    startDate: "2026-03-01",
    durationDays: 7,
    requiresProbiotics: true,
  };

  it("schedules day 3, the no-reply check, probiotic start and outcome on their days (BC-21)", () => {
    const plan = planSequence(rx, signedSettings());
    expect(sequenceSchedule(plan, "2026-03-01")).toEqual({
      steps: [
        { step: "ABX_DAY3", date: "2026-03-03" },
        { step: "NO_REPLY_CHECK", date: "2026-03-08" },
        { step: "PROBIOTIC_START", date: "2026-03-08" },
        { step: "TREATMENT_OUTCOME", date: "2026-03-17" },
      ],
      skipped: [],
    });
  });

  it("never schedules a step whose day has passed, and leaves out steps without a date", () => {
    const plan = planSequence(rx, signedSettings());
    const r = sequenceSchedule(plan, "2026-03-05");
    expect(r.steps.map((s) => s.step)).toEqual([
      "NO_REPLY_CHECK",
      "PROBIOTIC_START",
      "TREATMENT_OUTCOME",
    ]);
    expect(r.skipped).toEqual([{ step: "ABX_DAY3", reason: "date_passed" }]);

    // day-3 offset and probiotic duration unsigned: no ABX_DAY3, no TREATMENT_OUTCOME (fail closed)
    const unsigned = planSequence(
      rx,
      settingsWithUnsigned(["day3_offset_days", "probiotic_default_days"]),
    );
    expect(sequenceSchedule(unsigned, "2026-03-01").skipped).toEqual([
      { step: "ABX_DAY3", reason: "no_date" },
      { step: "TREATMENT_OUTCOME", reason: "no_date" },
    ]);
    // no probiotics: no PROBIOTIC_START and no outcome
    const noPro = planSequence({ ...rx, requiresProbiotics: false }, signedSettings());
    expect(sequenceSchedule(noPro, "2026-03-01").steps.map((s) => s.step)).toEqual([
      "ABX_DAY3",
      "NO_REPLY_CHECK",
    ]);
  });

  it("schedules nothing for a non-antibiotic or a course without a duration (TP-19, BC-22)", () => {
    for (const plan of [
      planSequence({ ...rx, drugClass: "unclassified" }, signedSettings()),
      planSequence({ ...rx, drugClass: "steroid" }, signedSettings()),
    ])
      expect(sequenceSchedule(plan, "2026-03-01")).toEqual({ steps: [], skipped: [] });
    const noDuration = planSequence({ ...rx, durationDays: null }, signedSettings());
    expect(noDuration.notes).toContain("duration_missing");
    expect(sequenceSchedule(noDuration, "2026-03-01").steps).toEqual([]);
  });

  it("decides each step from the sequence status (probiotic never after a halt, R-15)", () => {
    const d = (
      step: Parameters<typeof decideSequenceStep>[0],
      status: Parameters<typeof decideSequenceStep>[1]["status"],
      today = "2026-03-08",
    ) => decideSequenceStep(step, { status, endDate: "2026-03-07" }, today);
    expect(d("ABX_DAY3", "not_started")).toEqual({
      action: "dispatch",
      templateKey: "ABX_DAY3",
      nextStatus: "awaiting_day3_reply",
    });
    expect(d("ABX_DAY3", "awaiting_day3_reply").action).toBe("skip");
    expect(d("PROBIOTIC_START", "awaiting_probiotic")).toMatchObject({
      action: "dispatch",
      nextStatus: "probiotic_sent",
    });
    expect(d("PROBIOTIC_START", "not_started").action).toBe("dispatch"); // gate decides; nothing was sent at day 3
    for (const s of [
      "halted_clinical",
      "awaiting_clarification",
      "probiotic_sent",
      "complete",
    ] as const)
      expect(d("PROBIOTIC_START", s).action, s).toBe("skip");
    expect(d("TREATMENT_OUTCOME", "probiotic_sent")).toMatchObject({
      action: "dispatch",
      nextStatus: "outcome_sent",
    });
    expect(d("TREATMENT_OUTCOME", "not_started").action).toBe("skip");
    // R-17 (TP-12): silent after the end date → nurse task; otherwise nothing
    expect(d("NO_REPLY_CHECK", "awaiting_day3_reply")).toEqual({
      action: "nurse_task",
      reason: "no_reply_by_end_date",
    });
    expect(d("NO_REPLY_CHECK", "awaiting_probiotic").action).toBe("skip");
    expect(d("NO_REPLY_CHECK", "awaiting_day3_reply", "2026-03-07").action).toBe("skip");
  });
});

describe("medication class suggestion (legacy heuristic, suggestion only)", () => {
  it("follows the Make order and never returns a class for blank text", () => {
    expect(suggestMedicationClass("Corticosteroid + Antibiotic", null)).toBe("antibiotic");
    expect(suggestMedicationClass(null, ["Corticosteroid"])).toBe("steroid");
    expect(suggestMedicationClass("Probiotic", [])).toBe("probiotic");
    expect(suggestMedicationClass("Vitamin D", null)).toBe("supplement");
    expect(suggestMedicationClass("Analgesic", null)).toBe("other");
    expect(suggestMedicationClass("  ", [])).toBe("unclassified");
    expect(suggestMedicationClass(null, null)).toBe("unclassified");
  });
});
