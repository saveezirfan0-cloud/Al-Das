/**
 * Acceptance tests for lib/clinical: the Airtable Test Plan (TP-01…TP-20) and the derived boundary
 * cases (BC-nn) from docs/audit/clinical-rules.md §5. Synthetic data only.
 * Not covered here: BC-25…30 and BC-49…51 (chronic recall), which is a campaign feature, not Phase 6.
 */
import { describe, expect, it } from "vitest";

import { ageAtVisit } from "@/lib/clinical/age";
import { departmentEffective, mapDepartment } from "@/lib/clinical/department";
import { evaluateVisit, inputsHash } from "@/lib/clinical/evaluate";
import { evaluateRedFlag, notificationTargets, parseScore } from "@/lib/clinical/feedback";
import { addWorkdays, dedupeKey, followUpDueDate, workdaysBetween } from "@/lib/clinical/followup";
import { decideClinicalSend } from "@/lib/clinical/gate";
import { ingestVisitFields } from "@/lib/clinical/ingest";
import { scrubNarrative } from "@/lib/clinical/negation";
import {
  canSendProbiotic,
  decideDay3Reply,
  noReplyCheck,
  planSequence,
} from "@/lib/clinical/sequence";
import { ClinicalSettings, Needs } from "@/lib/clinical/settings";
import { containsTerm } from "@/lib/clinical/text";
import { parseBp, parseVital, PLAUSIBLE, vitalsComplete } from "@/lib/clinical/vitals";

import {
  gyn,
  MON_FRI,
  MON_SAT,
  paeds,
  settingsWithUnsigned,
  signedSettings,
  visit,
} from "./test-support";

const S = signedSettings();
const run = (v: ReturnType<typeof visit>, s = S, cal = MON_SAT) => evaluateVisit(v, s, cal);

describe("Test Plan (TP-01…TP-20)", () => {
  it("TP-01 seizure exclusion: a febrile seizure alone triggers nothing", () => {
    const r = run(paeds({ primaryDiagnosisText: "Febrile seizure" }));
    expect(r.rulesFired).toEqual([]);
    expect(r.triggerCategory).toBeNull();
    expect(r.dedupeKey).toBeNull();
  });

  it("TP-02 gynaecology imaging exclusion: suspected adenomyosis on TVUS does not trigger", () => {
    const r = run(gyn({ observationNotesRaw: "TVUS shows suspected adenomyosis" }));
    expect(r.rulesFired).toEqual([]);
  });

  it("TP-03 infant boundary, general threshold: 2y1m at 39.0 triggers PAED-01 only", () => {
    const r = run(paeds({ dob: "2024-02-10", tempC: 39.0 }));
    expect(r.ageAtVisit).toBe(2);
    expect(r.rulesFired).toEqual(["PAED-01"]);
  });

  it("TP-04 day 3 unwell: ABX_UNWELL, halted, doctor alerted, High queue item, probiotic suppressed", () => {
    const d = decideDay3Reply({ score: 3 }, S);
    expect(d).toMatchObject({
      action: "halt",
      status: "halted_clinical",
      sendTemplate: "ABX_UNWELL",
      alertDoctor: true,
      followUpPriority: "high",
    });
    expect(canSendProbiotic(d.status)).toBe(false);
  });

  it("TP-05 working-week roll: a Friday visit rolls to the clinic's next operating day", () => {
    const need = new Needs(S);
    expect(followUpDueDate("2026-10-09", "vitals", "", MON_SAT, need)).toBe("2026-10-10"); // Saturday
    expect(followUpDueDate("2026-10-09", "vitals", "", MON_FRI, need)).toBe("2026-10-12"); // Monday
    expect(
      followUpDueDate("2026-10-09", "vitals", "", { ...MON_SAT, holidays: ["2026-10-10"] }, need),
    ).toBe("2026-10-12");
  });

  it("TP-06 infant boundary, outside: 2y1m at 38.0 does not trigger", () => {
    expect(run(paeds({ dob: "2024-02-10", tempC: 38.0 })).rulesFired).toEqual([]);
  });

  it("TP-07 duplicate sync: the same visit and category always yield the same key", () => {
    const v = paeds({ externalId: "V-7", tempC: 39.5 });
    const a = run(v);
    const b = run(v);
    expect(a.dedupeKey).toBe("V-7-paediatric_high_concern");
    expect(b.dedupeKey).toBe(a.dedupeKey);
    expect(inputsHash(v, a.settingsSnapshot)).toBe(inputsHash(v, b.settingsSnapshot));
  });

  it("TP-08 BP string: 92/61 parses to 92 and 61", () => {
    expect(parseBp("92/61", null)).toEqual({ systolic: 92, diastolic: 61 });
  });

  it("TP-09 age at visit, not today: 1y7m at the visit triggers PAED-02 at 38.0", () => {
    const r = run(paeds({ visitDate: "2026-03-10", dob: "2024-08-10", tempC: 38.0 }));
    expect(r.ageAtVisit).toBe(1);
    expect(r.rulesFired).toEqual(["PAED-02-INFANT"]);
  });

  it("TP-10 unparseable reply: no score guessed, routed to a human", () => {
    expect(parseScore("not great honestly")).toBeNull();
    expect(decideDay3Reply({ score: parseScore("not great honestly") }, S)).toMatchObject({
      action: "clarify",
      status: "awaiting_clarification",
      humanTask: true,
      sendTemplate: null,
    });
  });

  it("TP-11 multi-trigger visit: one category, one key", () => {
    const r = run(paeds({ tempC: 39.5, procedureNotes: "Wound dressing" }));
    expect(r.rulesFired).toContain("PAED-01");
    expect(r.triggerCategory).toBe("paediatric_high_concern");
    expect(r.dedupeKey).toBe("V-1-paediatric_high_concern");
  });

  it("TP-12 no day-3 reply by the end date: the sequence proceeds and a nurse call is raised", () => {
    expect(
      noReplyCheck({ status: "awaiting_day3_reply", endDate: "2026-03-07" }, "2026-03-08"),
    ).toEqual({
      proceed: true,
      raiseNurseCallTask: true,
    });
    expect(
      noReplyCheck({ status: "awaiting_day3_reply", endDate: "2026-03-07" }, "2026-03-07")
        .raiseNurseCallTask,
    ).toBe(false);
    expect(
      noReplyCheck({ status: "awaiting_probiotic", endDate: "2026-03-07" }, "2026-03-20")
        .raiseNurseCallTask,
    ).toBe(false);
  });

  it("TP-13 day 3 improving: probiotic scheduled for end date + 1", () => {
    const d = decideDay3Reply({ score: 7 }, S);
    expect(d).toMatchObject({ action: "continue", status: "awaiting_probiotic" });
    const plan = planSequence(
      {
        drugClass: "antibiotic",
        startDate: "2026-03-01",
        durationDays: 7,
        requiresProbiotics: true,
      },
      S,
    );
    expect(plan.probioticStartDate).toBe("2026-03-08");
    expect(canSendProbiotic(d.status)).toBe(true);
  });

  it("TP-14 infant boundary, inside: 1y11m at 38.0 triggers PAED-02-INFANT", () => {
    const r = run(paeds({ visitDate: "2026-03-10", dob: "2024-04-10", tempC: 38.0 }));
    expect(r.ageAtVisit).toBe(1);
    expect(r.rulesFired).toEqual(["PAED-02-INFANT"]);
  });

  it("TP-15 test-record isolation: nothing reaches a real number", () => {
    const base = { gateEnabled: true, templateApproved: true, hasConsent: true };
    expect(
      decideClinicalSend({ ...base, sendMode: "test", contactIsTestRecord: false }),
    ).toMatchObject({
      allow: false,
      status: "suppressed_test_record",
    });
    expect(decideClinicalSend({ ...base, sendMode: "test", contactIsTestRecord: true }).allow).toBe(
      true,
    );
    expect(
      decideClinicalSend({ ...base, sendMode: "live", contactIsTestRecord: true }),
    ).toMatchObject({
      allow: false,
      status: "suppressed_test_record",
    });
  });

  it("TP-16 a side effect overrides a high score: 8 but I have a rash", () => {
    const flag = evaluateRedFlag(
      { score: parseScore("8 but I have a rash"), text: "8 but I have a rash" },
      S,
    );
    expect(flag).toMatchObject({
      redFlag: true,
      scoreFlag: false,
      keywordFlag: true,
      keywordsHit: ["rash"],
    });
    expect(notificationTargets(flag)).toEqual({ doctor: true, coordinator: true });
  });

  it("TP-17 Pap smear, positive: triggers GYN-08", () => {
    expect(run(gyn({ procedureNotes: "Pap smear", papResult: "positive" })).rulesFired).toContain(
      "GYN-08-PAP",
    );
  });

  it("TP-18 blank vitals guard: a GP visit with no vitals does not trigger", () => {
    const r = run(visit());
    expect(r.rulesFired).toEqual([]);
    expect(r.vitalsComplete).toBe(false);
  });

  it("TP-19 unclassified medication fails closed: no sequence, no GP-05", () => {
    expect(
      planSequence(
        {
          drugClass: "unclassified",
          startDate: "2026-03-01",
          durationDays: 7,
          requiresProbiotics: true,
        },
        S,
      ).applicable,
    ).toBe(false);
    expect(run(visit({ prescriptionClasses: ["unclassified"] })).rulesFired).toEqual([]);
  });

  it("TP-20 Pap smear, negative: does not trigger via GYN-08", () => {
    expect(
      run(
        gyn({
          procedureNotes: "Pap smear",
          papResult: "negative",
          observationNotesRaw: "mild discomfort",
        }),
      ).rulesFired,
    ).not.toContain("GYN-08-PAP");
  });
});

describe("Boundary cases (BC)", () => {
  it.each([
    ["BC-01 38.9", { tempC: 38.9 }, false],
    ["BC-02 39.0", { tempC: 39.0 }, true],
    ["BC-03 SpO2 95", { spo2: 95 }, false],
    ["BC-03 SpO2 94", { spo2: 94 }, true],
    ["BC-04 systolic 90", { bpSystolic: 90 }, false],
    ["BC-04 systolic 89", { bpSystolic: 89 }, true],
    ["BC-05 pulse 109", { pulse: 109 }, false],
    ["BC-05 pulse 110", { pulse: 110 }, true],
  ])("%s", (_name, over, fires) => {
    expect(run(visit(over)).rulesFired.includes("GP-01-VITALS")).toBe(fires);
  });

  it("BC-06 General, 13y11m at the visit → paediatrics", () => {
    const r = run(visit({ visitDate: "2026-03-10", dob: "2012-04-10" }));
    expect(r.ageAtVisit).toBe(13);
    expect(r.departmentEffective).toBe("paediatrics");
  });

  it("BC-07 General, exactly 14y0d → gp", () => {
    const r = run(visit({ visitDate: "2026-03-10", dob: "2012-03-10" }));
    expect(r.ageAtVisit).toBe(14);
    expect(r.departmentEffective).toBe("gp");
  });

  it("BC-08 no DOB, department 'Pediatrics' → paediatrics by mapping; PAED-02 cannot fire", () => {
    const r = run(paeds({ dob: null, departmentRaw: "Pediatrics", tempC: 38.0 }));
    expect(r.departmentEffective).toBe("paediatrics");
    expect(r.rulesFired).toEqual([]);
  });

  it("BC-09 / BC-10 BP string handling", () => {
    expect(parseBp(null, "120/80")).toEqual({ systolic: 120, diastolic: 80 });
    expect(parseBp("", "120/80")).toEqual({ systolic: 120, diastolic: 80 });
    for (const bad of ["120/", "abc", "/80", "120", "400/80", "120/5"])
      expect(parseBp(bad, null), bad).toEqual({ systolic: null, diastolic: null });
    expect(parseBp("120", "80")).toEqual({ systolic: 120, diastolic: 80 }); // two separate plain numbers
    expect(
      vitalsComplete({ tempC: 36.6, pulse: 70, spo2: 98, bpSystolic: 120, bpDiastolic: null }),
    ).toBe(false);
  });

  it("BC-11 denied symptoms are scrubbed away → no GP-02", () => {
    expect(
      run(visit({ observationNotesRaw: "denies chest pain, no shortness of breath" })).rulesFired,
    ).toEqual([]);
  });

  it("BC-12 a symptom that survives scrubbing still flags GP-02", () => {
    expect(
      run(visit({ observationNotesRaw: "chest pain on exertion, denies syncope" })).rulesFired,
    ).toContain("GP-02-REDFLAG");
  });

  it("BC-13 'denies blood in stool' never makes the category Bleeding (coded fields only)", () => {
    const r = run(
      visit({
        primaryDiagnosisText: "gastroenteritis",
        observationNotesRaw: "denies blood in stool",
        procedureNotes: "dressing",
      }),
    );
    expect(r.triggerCategory).toBe("post_procedure");
  });

  it("BC-14 menorrhagia → GYN-01 and Bleeding", () => {
    const r = run(gyn({ primaryDiagnosisText: "Menorrhagia" }));
    expect(r.rulesFired).toContain("GYN-01-BLEED");
    expect(r.triggerCategory).toBe("bleeding");
  });

  it("BC-15 / BC-16 structural findings alone vs with a symptom", () => {
    expect(run(gyn({ observationNotesRaw: "fibroid noted on scan" })).rulesFired).toEqual([]);
    expect(run(gyn({ observationNotesRaw: "fibroid, heavy bleeding" })).rulesFired).toContain(
      "GYN-05-PAIN",
    );
  });

  it("BC-17 gynae systolic 94 needs the symptomatic flag", () => {
    expect(run(gyn({ bpSystolic: 94, symptomatic: false })).rulesFired).toEqual([]);
    expect(run(gyn({ bpSystolic: 94, symptomatic: null })).rulesFired).toEqual([]);
    expect(run(gyn({ bpSystolic: 94, symptomatic: true })).rulesFired).toContain("GYN-06-VITALS");
  });

  it("BC-18 Pap performed but result 'not available' → no GYN-08", () => {
    expect(
      run(gyn({ procedureNotes: "Pap smear", papResult: "not_available" })).rulesFired,
    ).not.toContain("GYN-08-PAP");
    expect(run(gyn({ procedureNotes: "Pap smear", papResult: null })).rulesFired).not.toContain(
      "GYN-08-PAP",
    );
  });

  it("BC-19 'routine check' does not match the short term 'uti'", () => {
    expect(run(paeds({ primaryDiagnosisText: "routine check" })).rulesFired).toEqual([]);
    expect(run(paeds({ primaryDiagnosisText: "UTI" })).rulesFired).toContain("PAED-07");
    expect(containsTerm("pelvic inflammatory disease", "pid")).toBe(false);
    expect(containsTerm("PID suspected", "pid")).toBe(true);
    expect(containsTerm("infection of the wound", "infect")).toBe(true);
  });

  it("BC-20 a legacy 'Corticosteroid + Antibiotic' label with no code mapping classifies nothing", () => {
    expect(run(visit({ prescriptionClasses: ["unclassified"] })).rulesFired).not.toContain(
      "GP-05-MEDS",
    );
  });

  it("BC-21 sequence dates", () => {
    const rx = {
      drugClass: "antibiotic" as const,
      startDate: "2026-03-01",
      durationDays: 7,
      requiresProbiotics: true,
    };
    expect(planSequence(rx, S)).toMatchObject({
      endDate: "2026-03-07",
      day3CheckDate: "2026-03-03",
      probioticStartDate: "2026-03-08",
      probioticEndDate: "2026-03-17",
    });
    expect(planSequence(rx, signedSettings({ day3_offset_days: 3 })).day3CheckDate).toBe(
      "2026-03-04",
    );
    expect(planSequence({ ...rx, requiresProbiotics: false }, S).probioticStartDate).toBeNull();
    expect(planSequence({ ...rx, probioticDaysOverride: 7 }, S).probioticEndDate).toBe(
      "2026-03-14",
    );
  });

  it("BC-22 no duration → no dates and a note", () => {
    for (const durationDays of [null, 0]) {
      const p = planSequence(
        {
          drugClass: "antibiotic",
          startDate: "2026-03-01",
          durationDays,
          requiresProbiotics: true,
        },
        S,
      );
      expect(p).toMatchObject({
        applicable: true,
        endDate: null,
        day3CheckDate: null,
        probioticStartDate: null,
      });
      expect(p.notes).toContain("duration_missing");
    }
  });

  it("BC-23 day-3 reply with the HALT threshold unsigned → human, nothing sent", () => {
    const unsigned = settingsWithUnsigned(["day3_halt_threshold"]);
    expect(decideDay3Reply({ score: 5 }, unsigned)).toMatchObject({
      action: "human_review",
      status: "awaiting_clarification",
      sendTemplate: null,
      humanTask: true,
    });
  });

  it("BC-24 keyword list unsigned → score kept, side effects can't be evaluated → human review", () => {
    const flag = evaluateRedFlag(
      { score: 7, text: "7, slight rash" },
      settingsWithUnsigned(["side_effect_keywords"]),
    );
    expect(flag).toMatchObject({
      redFlag: false,
      needsHumanReview: true,
      missingSettings: ["side_effect_keywords"],
    });
  });

  it("BC-31 a changed category is a different key", () => {
    expect(dedupeKey("V-9", "vitals")).not.toBe(dedupeKey("V-9", "post_procedure"));
  });

  it("BC-32 gate closed: suppressed even when everything else is fine", () => {
    expect(
      decideClinicalSend({
        gateEnabled: false,
        sendMode: "live",
        contactIsTestRecord: false,
        templateApproved: true,
        hasConsent: true,
      }),
    ).toMatchObject({ allow: false, status: "suppressed_gate" });
  });

  it("BC-33…BC-38 paediatric rules", () => {
    expect(
      run(
        paeds({
          primaryDiagnosisText: "viral fever",
          observationNotesRaw: "child unwell, off food",
        }),
      ).rulesFired,
    ).toContain("PAED-03");
    const spo2 = run(paeds({ spo2: 94 }));
    expect(spo2.rulesFired).toContain("PAED-04");
    expect(spo2.triggerCategory).toBe("paediatric_high_concern");
    expect(run(paeds({ observationNotesRaw: "wheeze on auscultation" })).rulesFired).toContain(
      "PAED-05",
    );
    expect(
      run(
        paeds({
          primaryDiagnosisText: "gastroenteritis",
          observationNotesRaw: "vomiting x3 and poor intake",
        }),
      ).rulesFired,
    ).toContain("PAED-06");
    expect(
      run(paeds({ primaryDiagnosisText: "gastroenteritis", observationNotesRaw: "vomiting x3" }))
        .rulesFired,
    ).not.toContain("PAED-06");
    const inv = run(paeds({ investigationCount: 1 }));
    expect(inv.rulesFired).toContain("PAED-08");
    expect(inv.followUpDueDate).toBe("2026-03-11"); // next working day after Tue 10 Mar
    expect(run(paeds({ planOfTreatment: "return if worse" })).rulesFired).toContain("PAED-09");
  });

  it("BC-39…BC-42 GP rules and due dates", () => {
    expect(
      run(visit({ primaryDiagnosisText: "cellulitis", investigationCount: 1 })).rulesFired,
    ).toContain("GP-03");
    expect(
      run(visit({ primaryDiagnosisText: "cellulitis", investigationCount: 0 })).rulesFired,
    ).not.toContain("GP-03");
    expect(
      run(visit({ primaryDiagnosisText: "cellulitis", investigationCount: null })).rulesFired,
    ).not.toContain("GP-03");
    const proc = run(visit({ procedureNotes: "wound dressing" }));
    expect(proc).toMatchObject({
      triggerCategory: "post_procedure",
      followUpDueDate: "2026-03-12",
    }); // +2 working days
    expect(run(visit({ prescriptionClasses: ["antibiotic"] })).rulesFired).toContain("GP-05-MEDS");
    expect(run(visit({ prescriptionClasses: ["steroid"] })).rulesFired).toContain("GP-05-MEDS");
    const review = run(visit({ planOfTreatment: "review in 5 days" }));
    expect(review.rulesFired).toContain("GP-06");
    expect(review.followUpDueDate).toBe("2026-03-15"); // OQ-40: visit + 5 days
    expect(run(visit({ planOfTreatment: "review in 6 weeks" })).followUpDueDate).toBe("2026-03-12"); // beyond the cap → category default
  });

  it("BC-43…BC-47 gynaecology rules", () => {
    const active = run(gyn({ observationNotesRaw: "active bleeding noted" }));
    expect(active.rulesFired).toContain("GYN-02-BLEED");
    expect(active.triggerCategory).toBe("clinical_check"); // no bleeding in the CODED fields
    expect(
      run(gyn({ primaryDiagnosisText: "bleeding", observationNotesRaw: "active bleeding noted" }))
        .triggerCategory,
    ).toBe("bleeding");
    const both = run(gyn({ observationNotesRaw: "spotting with pelvic pain" }));
    expect(both.rulesFired).toEqual(expect.arrayContaining(["GYN-03", "GYN-05-PAIN"]));
    expect(run(gyn({ investigationsOrdered: "HVS culture" })).rulesFired).toContain(
      "GYN-04-INFECT",
    );
    expect(run(gyn({ primaryDiagnosisText: "cervicitis" })).rulesFired).toContain("GYN-04-INFECT");
    expect(run(gyn({ observationNotesRaw: "foul discharge" })).rulesFired).toContain(
      "GYN-04-INFECT",
    );
    const biopsy = run(gyn({ procedureNotes: "cervical biopsy" }));
    expect(biopsy.rulesFired).toContain("GYN-07-PROC");
    expect(biopsy.triggerCategory).toBe("post_procedure");
    expect(run(gyn({ planOfTreatment: "review after results" })).rulesFired).toContain("GYN-09");
    expect(run(gyn({ pulse: 100, observationNotesRaw: "pelvic pain" })).rulesFired).toContain(
      "GYN-06-VITALS",
    );
    expect(run(gyn({ pulse: 100 })).rulesFired).not.toContain("GYN-06-VITALS");
  });

  it("BC-48 missing SpO2: vitals incomplete, present values still evaluated", () => {
    const r = run(visit({ tempC: 39.2, bpSystolic: 120, bpDiastolic: 80, pulse: 80, spo2: null }));
    expect(r.vitalsComplete).toBe(false);
    expect(r.rulesFired).toContain("GP-01-VITALS");
  });

  it("the category cascade follows the spec order", () => {
    // vitals beat infection, infection beats procedure
    const v = run(
      visit({
        tempC: 39.5,
        primaryDiagnosisText: "cellulitis",
        investigationCount: 1,
        procedureNotes: "dressing",
      }),
    );
    expect(v.triggerCategory).toBe("vitals");
    expect(v.followUpDueDate).toBe("2026-03-11");
    const i = run(
      visit({
        primaryDiagnosisText: "cellulitis",
        investigationCount: 1,
        procedureNotes: "dressing",
      }),
    );
    expect(i.triggerCategory).toBe("infection_labs");
    // the category's vitals step uses the gynae BP / pulse thresholds even for a GP visit
    expect(run(visit({ bpSystolic: 94, procedureNotes: "dressing" })).triggerCategory).toBe(
      "vitals",
    );
  });
});

describe("fail closed on unsigned settings", () => {
  const sick = visit({ tempC: 40.0 });

  it("an unsigned threshold switches its rule off and says so", () => {
    const r = run(sick, settingsWithUnsigned(["adult_fever_temp_c"]));
    expect(r.rulesFired).toEqual([]);
    expect(r.missingSettings).toContain("adult_fever_temp_c");
  });

  it("OR-terms are independent: another signed threshold still catches its vital", () => {
    const r = run(visit({ tempC: 40.0, spo2: 90 }), settingsWithUnsigned(["adult_fever_temp_c"]));
    expect(r.rulesFired).toEqual(["GP-01-VITALS"]);
    expect(r.missingSettings).toContain("adult_fever_temp_c");
  });

  it("proposed values are used only after the org signs off allow_unsigned_defaults", () => {
    const unsignedRow = {
      key: "allow_unsigned_defaults",
      approved_value: null,
      proposed_value: "true",
      sign_off_status: "awaiting" as const,
    };
    const signedRow = {
      ...unsignedRow,
      approved_value: "true",
      sign_off_status: "approved" as const,
    };
    expect(
      run(sick, settingsWithUnsigned(["adult_fever_temp_c"], [unsignedRow])).rulesFired,
    ).toEqual([]);
    expect(run(sick, settingsWithUnsigned(["adult_fever_temp_c"], [signedRow])).rulesFired).toEqual(
      ["GP-01-VITALS"],
    );
  });

  it("an approved value on a row that isn't signed off is ignored", () => {
    const s = new ClinicalSettings([
      {
        key: "adult_fever_temp_c",
        approved_value: "39",
        proposed_value: "39",
        sign_off_status: "awaiting",
      },
    ]);
    expect(s.num("adult_fever_temp_c")).toBeUndefined();
  });

  it("a known age with an unsigned paediatric cut-off is 'undetermined', never quietly GP", () => {
    const toddler = visit({ dob: "2023-03-01", tempC: 39.5 });
    const r = run(toddler, settingsWithUnsigned(["paeds_age_cutoff_years"]));
    expect(r.departmentEffective).toBeNull();
    expect(r.rulesFired).toEqual([]);
    expect(r.missingSettings).toContain("paeds_age_cutoff_years");
    // with no DOB the cut-off isn't needed
    expect(
      run(visit({ dob: null }), settingsWithUnsigned(["paeds_age_cutoff_years"]))
        .departmentEffective,
    ).toBe("gp");
  });

  it("narrative rules stay silent when the negation cues aren't signed off", () => {
    const v = visit({ observationNotesRaw: "chest pain" });
    expect(run(v).rulesFired).toContain("GP-02-REDFLAG");
    const r = run(v, settingsWithUnsigned(["negation_cues"]));
    expect(r.rulesFired).toEqual([]);
    expect(r.observationNotesScrubbed).toBeNull();
    expect(r.missingSettings).toContain("negation_cues");
  });

  it("with nothing signed off nothing fires at all", () => {
    const everything = settingsWithUnsigned(Object.keys(signedSettings().snapshot([])));
    void everything;
    const none = new ClinicalSettings([]);
    for (const v of [
      visit({ tempC: 41, spo2: 80 }),
      paeds({ tempC: 41 }),
      gyn({ procedureNotes: "biopsy" }),
    ])
      expect(run(v, none).rulesFired).toEqual([]);
  });

  it("the patient-facing gate ignores allow_unsigned_defaults and proposed values", () => {
    const rows = [
      {
        key: "allow_unsigned_defaults",
        approved_value: "true",
        proposed_value: "true",
        sign_off_status: "approved" as const,
      },
      {
        key: "clinical_messaging_enabled",
        approved_value: null,
        proposed_value: "true",
        sign_off_status: "awaiting" as const,
      },
    ];
    expect(new ClinicalSettings(rows).messagingEnabled()).toBe(false);
    const signed = [
      rows[0],
      { ...rows[1], approved_value: "true", sign_off_status: "approved" as const },
    ];
    expect(new ClinicalSettings(signed).messagingEnabled()).toBe(true);
    const signedFalse = [
      rows[0],
      { ...rows[1], approved_value: "false", sign_off_status: "approved" as const },
    ];
    expect(new ClinicalSettings(signedFalse).messagingEnabled()).toBe(false);
  });

  it("the gate blocks in the documented order", () => {
    const ok = {
      gateEnabled: true,
      sendMode: "live" as const,
      contactIsTestRecord: false,
      templateApproved: true,
      hasConsent: true,
    };
    expect(decideClinicalSend(ok)).toMatchObject({ allow: true, status: "send" });
    expect(decideClinicalSend({ ...ok, templateApproved: false })).toMatchObject({
      allow: false,
      status: "blocked",
    });
    expect(decideClinicalSend({ ...ok, hasConsent: false })).toMatchObject({
      allow: false,
      status: "blocked",
      reason: "no_clinical_messaging_consent",
    });
    expect(
      decideClinicalSend({ ...ok, gateEnabled: false, templateApproved: false }),
    ).toMatchObject({ status: "suppressed_gate" });
  });
});

describe("building blocks", () => {
  it("negation scrubbing cuts from the cue to the next boundary", () => {
    const cues = S.list("negation_cues")!;
    expect(
      scrubNarrative("Chest pain, denies fever; no cough but wheeze however alert", cues),
    ).toBe("Chest pain, wheeze, alert");
    expect(scrubNarrative("normal examination, nodule felt", cues)).toBe(
      "normal examination, nodule felt",
    ); // 'no' inside words is not a cue
    expect(scrubNarrative("fever. no vomiting.\nnot eating", cues)).toBe("fever");
    expect(scrubNarrative("", cues)).toBe("");
  });

  it("numeric vitals: blank is null, never zero; implausible is null", () => {
    expect(parseVital("", PLAUSIBLE.temp)).toBeNull();
    expect(parseVital("37.5 C", PLAUSIBLE.temp)).toBe(37.5);
    expect(parseVital("98.6.1", PLAUSIBLE.temp)).toBeNull();
    expect(parseVital("0", PLAUSIBLE.spo2)).toBeNull();
    expect(parseVital(250, PLAUSIBLE.pulse)).toBe(250);
    expect(parseVital(251, PLAUSIBLE.pulse)).toBeNull();
    expect(
      ingestVisitFields({
        bpSystolic: "92/61",
        temperature: "38.2",
        pulse: "",
        spo2: "n/a",
        complaints: "cough",
        nurseNotes: "calm",
      }),
    ).toMatchObject({
      bpSystolic: 92,
      bpDiastolic: 61,
      tempC: 38.2,
      pulse: null,
      spo2: null,
      observationNotesRaw: "cough calm",
    });
  });

  it("age at visit counts full years on the visit date", () => {
    expect(ageAtVisit("2012-03-10", "2026-03-10")).toBe(14);
    expect(ageAtVisit("2012-03-11", "2026-03-10")).toBe(13);
    expect(ageAtVisit(null, "2026-03-10")).toBeNull();
    expect(ageAtVisit("2027-01-01", "2026-03-10")).toBeNull();
    expect(ageAtVisit("2020-02-30", "2026-03-10")).toBeNull();
  });

  it("department mapping starts at a word boundary (orthopaedics is not paediatrics)", () => {
    expect(mapDepartment("Paediatrics")).toBe("paediatrics");
    expect(mapDepartment("Pediatrics")).toBe("paediatrics");
    expect(mapDepartment("Orthopaedics")).toBe("other");
    expect(mapDepartment("Obstetrics & Gynaecology")).toBe("gynaecology");
    expect(mapDepartment("Internal Medicine")).toBe("gp");
    expect(mapDepartment("Dermatology")).toBe("dermatology");
    expect(mapDepartment(null)).toBe("other");
  });

  it("doctor routing lists are exact, trimmed and case-insensitive", () => {
    const s = signedSettings({ doctor_routing_gynaecology: ["Dr Sample"] });
    expect(
      departmentEffective({ ageAtVisit: 30, doctorName: "  dr sample ", mapped: "gp" }, s)
        .department,
    ).toBe("gynaecology");
    expect(
      departmentEffective({ ageAtVisit: 30, doctorName: "Dr Sample Jr", mapped: "gp" }, s)
        .department,
    ).toBe("gp");
    // the age override beats routing
    expect(
      departmentEffective({ ageAtVisit: 5, doctorName: "Dr Sample", mapped: "gp" }, s).department,
    ).toBe("paediatrics");
  });

  it("score parsing", () => {
    expect(parseScore("I'd say 7")).toBe(7);
    expect(parseScore("10")).toBe(10);
    expect(parseScore("5/10")).toBe(5);
    expect(parseScore("about 3 out of 10, took 2 tablets")).toBe(3);
    expect(parseScore("٦")).toBe(6); // Arabic-Indic digit
    for (const none of ["", "fine", "7.5", "12", "0", "feeling 100%", "1234"])
      expect(parseScore(none), none).toBeNull();
  });

  it("red flag: score and keyword are independent tests", () => {
    expect(evaluateRedFlag({ score: 5, text: "ok" }, S)).toMatchObject({
      redFlag: true,
      scoreFlag: true,
      keywordFlag: false,
    });
    expect(evaluateRedFlag({ score: 6, text: "ok" }, S)).toMatchObject({
      redFlag: false,
      needsHumanReview: false,
    });
    expect(evaluateRedFlag({ score: null, text: "lots of swelling" }, S)).toMatchObject({
      redFlag: true,
      keywordFlag: true,
    });
    expect(
      evaluateRedFlag(
        { score: 2, text: "bad" },
        settingsWithUnsigned(["red_flag_score_threshold"]),
      ),
    ).toMatchObject({
      redFlag: false,
      needsHumanReview: true,
      thresholdUsed: null,
    });
  });

  it("workday maths uses the clinic's real calendar", () => {
    expect(addWorkdays("2026-10-09", 1, MON_FRI)).toBe("2026-10-12");
    expect(addWorkdays("2026-10-09", 1, MON_SAT)).toBe("2026-10-10");
    expect(addWorkdays("2026-10-09", 2, { ...MON_SAT, holidays: ["2026-10-12"] })).toBe(
      "2026-10-13",
    );
    expect(workdaysBetween("2026-10-08", "2026-10-12", MON_SAT)).toBe(3); // Fri, Sat, Mon
  });
});
