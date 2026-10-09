import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REGISTRY } from "../../scripts/import/registry";
import { entityOf, mapRecord, mapperFieldIds } from "../../scripts/import/tables/map";
import {
  acuteFeedbackMapper,
  acuteFollowupMapper,
  acuteMessageLogMapper,
  acutePrescriptionsMapper,
  acuteVisitsMapper,
  callScriptsMapper,
  doctorsMapper,
  mapCallStatus,
  mapFeedbackStage,
  mapOutcome,
  mapTriggerCategory,
  medicalRecordsMapper,
} from "../../scripts/import/tables/clinical";
import {
  appointmentMessagesMapper,
  birthdayMapper,
  chronicRecallMapper,
} from "../../scripts/import/tables/pending-logs";
import {
  cptMasterMapper,
  diagnosisMapper,
  itemsMapper,
  medicationMapper,
  medicationReferenceMapper,
  settingsMapper,
  websiteMapper,
} from "../../scripts/import/tables/reference";

const RAW = join(__dirname, "../../docs/audit/airtable-raw");
const rec = (fields: Record<string, unknown>) => ({ id: "recSYNTHETIC0001", fields });

describe("registry integrity", () => {
  const tables = REGISTRY.flatMap((e) => (e.type === "table" ? [e] : []));

  it("keys are unique and dependencies exist", () => {
    const keys = REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of REGISTRY) {
      if (e.type === "skip") continue;
      for (const d of e.dependsOn) expect(keys, `${e.key} → ${d}`).toContain(d);
    }
  });

  it("every field id a mapper reads exists in the committed Airtable schema export", () => {
    for (const { mapper: m } of tables) {
      const schema = JSON.parse(readFileSync(join(RAW, `${m.baseId}.schema.json`), "utf8")) as {
        tables: Array<{ id: string; fields: Array<{ id: string }> }>;
      };
      const t = schema.tables.find((x) => x.id === m.tableId);
      expect(t, `${m.key}: table ${m.tableId}`).toBeDefined();
      const ids = new Set(t!.fields.map((f) => f.id));
      for (const id of mapperFieldIds(m)) expect(ids.has(id), `${m.key}: ${id}`).toBe(true);
    }
  });

  it("mappers do not map two fields to one column, and links target registered tables", () => {
    for (const { mapper: m } of tables) {
      const cols = m.fields.map((f) => f.column);
      expect(new Set(cols).size, m.key).toBe(cols.length);
      for (const l of m.links ?? [])
        if (l.kind === "record")
          expect(
            REGISTRY.map((e) => e.key),
            `${m.key} → ${l.target}`,
          ).toContain(l.target);
    }
  });

  it("natural keys are columns the mapper produces (or derives)", () => {
    for (const { mapper: m } of tables) {
      const out = mapRecord(m, rec({}));
      for (const k of m.naturalKey) expect(k in out.values, `${m.key}.${k}`).toBe(true);
    }
  });

  it("every table in the audit is either mapped or listed as skipped with a reason", () => {
    const covered = new Set(
      REGISTRY.map((e) =>
        e.type === "skip"
          ? `${e.baseId}.${e.tableId}`
          : e.type === "table"
            ? entityOf(e.mapper)
            : `${e.mapper.baseId}.${e.mapper.tableId}`,
      ),
    );
    const raw = [
      "app7QJ2pvhADHQeBP",
      "appH2jHpsNR1nqEQ2",
      "appZbwlQvkuaUsF2l",
      "appkOnjPr1SMD83CP",
      "appVsJVw5jjj5YiMp",
    ];
    const missing: string[] = [];
    for (const base of raw) {
      const schema = JSON.parse(readFileSync(join(RAW, `${base}.schema.json`), "utf8")) as {
        tables?: Array<{ id: string; name: string }>;
      };
      for (const t of schema.tables ?? [])
        if (!covered.has(`${base}.${t.id}`)) missing.push(`${base}.${t.id} (${t.name})`);
    }
    expect(missing).toEqual([]);
    for (const e of REGISTRY) if (e.type === "skip") expect(e.reason.length).toBeGreaterThan(10);
  });
});

describe("ready mappers", () => {
  it("Diagnosis: checkboxes default to false, group is a lookup, blank code is invalid", () => {
    const ok = mapRecord(
      diagnosisMapper,
      rec({
        fldld9DKnsoLK9ADK: "I10",
        fldIGBzWtu2QFP0Yk: true,
        fldyz11Dj5wK2y2S8: { name: "Hypertension / Hypertensive disease" },
      }),
    );
    expect(ok.values).toMatchObject({
      code: "I10",
      chronic: true,
      top30: false,
      not_found_in_unite: false,
    });
    expect(ok.lookups).toEqual({ fldyz11Dj5wK2y2S8: "Hypertension / Hypertensive disease" });
    expect(mapRecord(diagnosisMapper, rec({})).invalid).toBe("missing code");
  });

  it("Medication: drops header artefacts, parses price, splits combos", () => {
    const m = mapRecord(
      medicationMapper,
      rec({
        fld7kgxlA3c0kjFdW: "D-001",
        fldQPwna6WcQkIsrb: "12.50",
        fldkhVVFyNnSz5T4n: "SOURCE",
        fldlWj6a725a6l54H: "REGISTERED_OWNER",
        fldQQsGZMJDEmcIkL: "IS_EBP",
        fld15ltyTEfiugYam: "Corticosteroid + Antibiotic",
        fldGvn9X6b6sNY9Xi: "2026-01-02",
      }),
    );
    expect(m.values).toMatchObject({
      ddc_code: "D-001",
      package_price: 12.5,
      source: null,
      registered_owner: null,
      is_ebp: null,
      all_medicine_types: ["Corticosteroid", "Antibiotic"],
      source_updated_on: "2026-01-02",
    });
    expect(
      mapRecord(medicationMapper, rec({ fld7kgxlA3c0kjFdW: "D-2", fldQQsGZMJDEmcIkL: "true" }))
        .values.is_ebp,
    ).toBe(true);
  });

  it("Items and CPT Master normalise item types and drop the header artefact", () => {
    expect(
      mapRecord(
        itemsMapper,
        rec({ fld0i0BQItTWZpTm5: "99213", fldDUW6cM6saCg5m8: { name: "Other Services" } }),
      ).values.item_type,
    ).toBe("OTHER_SERVICES");
    const art = mapRecord(
      itemsMapper,
      rec({ fld0i0BQItTWZpTm5: "X", fldDUW6cM6saCg5m8: "ItemType" }),
    );
    expect(art.values.item_type).toBeNull();
    expect(art.warnings).toContain("item_type_header_artefact");
    const cpt = mapRecord(
      cptMasterMapper,
      rec({ fldjaLpahs9NgSFAF: "80061", fldi4vFfiPdSU7ZxC: true, fldqsVvaiGRe59o9w: "Lipids" }),
    );
    expect(cpt.values).toMatchObject({
      code: "80061",
      doctor_verified: true,
      test_category: "Lipids",
    });
    expect(cptMasterMapper.fillBlankOnly).toEqual(["description", "item_type"]);
  });

  it("Medication Reference fails closed: unknown classes and heuristic suggestions are unclassified", () => {
    const base = { fld8IyFkiQC3VrDpH: "C1" };
    expect(
      mapRecord(
        medicationReferenceMapper,
        rec({ ...base, fldHUcvmoD8Sy8Yia: { name: "Antibiotic" } }),
      ).values.class,
    ).toBe("antibiotic");
    const unknown = mapRecord(
      medicationReferenceMapper,
      rec({ ...base, fldHUcvmoD8Sy8Yia: "Wizard potion" }),
    );
    expect(unknown.values.class).toBe("unclassified");
    expect(unknown.warnings).toContain("unknown_medication_class");
    expect(mapRecord(medicationReferenceMapper, rec(base)).values.class).toBe("unclassified");
    const h = mapRecord(
      medicationReferenceMapper,
      rec({ ...base, fldHUcvmoD8Sy8Yia: "Steroid", fldDSObi3AgyZAX3U: "Heuristic" }),
    );
    expect(h.values.class).toBe("unclassified");
    expect(h.warnings).toContain("heuristic_forced_unclassified");
  });

  it("Website: Yes/No becomes boolean; section and source are required", () => {
    const w = mapRecord(
      websiteMapper,
      rec({
        fld44pzWF1WiW96XW: "01. General Booking",
        fld87i81Uv5xEbCjh: "Home",
        fld6BmbGE4MDFZENr: "Yes",
      }),
    );
    expect(w.values).toMatchObject({
      section: "01. General Booking",
      source_key: "Home",
      is_dynamic: true,
    });
    expect(mapRecord(websiteMapper, rec({ fld44pzWF1WiW96XW: "x" })).invalid).toBeDefined();
  });

  it("Settings: category and status become enum keys", () => {
    const s = mapRecord(
      settingsMapper,
      rec({
        fldpn14HNQN3BFEfc: "Day-3 HALT threshold",
        fld7M5zm094N0rlcm: { name: "Medication Sequence" },
        fldezo13piyceP6Ex: { name: "Confirm exclusion" },
      }),
    );
    expect(s.values).toMatchObject({
      category: "medication_sequence",
      sign_off_status: "confirm_exclusion",
    });
  });
});

const CREATED = "2026-09-05T10:00:00.000Z";
const recAt = (fields: Record<string, unknown>) => ({
  id: "recSYNTHETIC0001",
  createdTime: CREATED,
  fields,
});
const warnings = (fn: (w: (c: string) => void) => unknown) => {
  const out: string[] = [];
  fn((c) => out.push(c));
  return out;
};

describe("clinical select mappers (tolerant, fail closed)", () => {
  it("trigger category, call status, outcome and stage match by meaning and flag the unknown", () => {
    const w: string[] = [];
    const warn = (c: string) => w.push(c);
    expect(mapTriggerCategory("Paediatric High-Concern", warn)).toBe("paediatric_high_concern");
    expect(mapTriggerCategory("Infection-Labs", warn)).toBe("infection_labs");
    expect(mapTriggerCategory("Astrology", warn)).toBeNull();
    expect(mapCallStatus("Pending", warn)).toBe("pending");
    expect(mapCallStatus("No Answer", warn)).toBe("no_answer");
    expect(mapCallStatus("Escalated to doctor", warn)).toBe("escalated");
    expect(mapCallStatus("Mystery", warn)).toBeNull();
    expect(mapOutcome("Improving", warn)).toBe("improving");
    expect(mapOutcome("Worse", warn)).toBe("worse");
    expect(mapOutcome("Reached", warn)).toBeNull();
    expect(mapFeedbackStage("Day 3 - Antibiotics", warn)).toBe("day3_antibiotics");
    expect(mapFeedbackStage("During Treatment", warn)).toBe("day3_antibiotics");
    expect(mapFeedbackStage("After Antibiotics", warn)).toBe("after_antibiotics");
    expect(mapFeedbackStage("After Probiotics", warn)).toBe("after_probiotics");
    expect(mapFeedbackStage("Post-Procedure", warn)).toBe("post_procedure");
    expect(mapFeedbackStage("Whenever", warn)).toBeNull();
    expect(w).toEqual([
      "unknown_trigger_category",
      "unknown_call_status",
      "unknown_outcome",
      "unknown_feedback_stage",
    ]);
  });
});

describe("clinical mappers (real Phase 6 columns)", () => {
  it("Doctors: name only; specialty becomes a department lookup; no external id", () => {
    const d = mapRecord(
      doctorsMapper,
      rec({ fld0ghl5SVDzYlwU0: " Dr Fake ", fldkfam3qESHnrbTr: "Dermatology" }),
    );
    expect(d.values).toEqual({ name: "Dr Fake" });
    expect(d.lookups).toEqual({ fldkfam3qESHnrbTr: "Dermatology" });
    expect(mapRecord(doctorsMapper, rec({})).invalid).toBe("missing name");
  });

  it("Medical Records → visits: source airtable, external id = record id, vitals via the plausibility windows", () => {
    const m = mapRecord(
      medicalRecordsMapper,
      rec({
        fldKuI5eXoDJIiOcu: "2026-09-01",
        fldQEoJfTLKODHoq7: "92/61",
        fldQWA9jjupL6EF3L: "38.24 C",
        fldOVaKPQc3VUwJnh: "",
        fldFzXAhtt2fcRTDy: "250",
        fldJajCqvONmaX3XL: "172",
        fldzdjzBPCdvG9U8U: "70.5",
        fld5GjbpREf5EvHRS: ["recA", "recB", "recC"],
        fldtxNjAanspw8h40: ["recPATIENT000001"],
        fldZiy0HG9KGApOtc: "Dr Fake",
      }),
    );
    expect(m.values).toMatchObject({
      external_id: "recSYNTHETIC0001",
      source: "airtable",
      visit_date: "2026-09-01",
      bp_systolic: 92,
      bp_diastolic: 61,
      temp_c: 38.2,
      pulse: null, // blank stays NULL, never 0
      spo2: null, // 250% is implausible: dropped, not clamped
      height_cm: 172,
      weight_kg: 70.5,
      investigation_count: 3,
      doctor_name: "Dr Fake",
    });
    expect(m.warnings).toContain("vital_dropped:spo2");
    expect(m.warnings).not.toContain("vital_dropped:pulse");
    expect(m.values.vitals_raw).toMatchObject({ temp: "38.24 C", bp_systolic: "92/61" });
    expect(m.links.fldtxNjAanspw8h40).toEqual(["recPATIENT000001"]);
    // columns that do not exist on visits are never produced
    expect(Object.keys(m.values)).not.toContain("legacy_acute_synced_on");
  });

  it("Medical Records: an implausible or ambiguous BP is dropped whole; a split BP is accepted", () => {
    const base = { fldKuI5eXoDJIiOcu: "2026-09-01" };
    const lone = mapRecord(medicalRecordsMapper, rec({ ...base, fldQEoJfTLKODHoq7: "120" }));
    expect(lone.values).toMatchObject({ bp_systolic: null, bp_diastolic: null });
    expect(lone.warnings).toContain("vital_dropped:bp");
    const wild = mapRecord(medicalRecordsMapper, rec({ ...base, fldQEoJfTLKODHoq7: "999/61" }));
    expect(wild.values.bp_systolic).toBeNull();
    const split = mapRecord(
      medicalRecordsMapper,
      rec({ ...base, fldQEoJfTLKODHoq7: "120", fldz0AtfcKuYy52FV: "80" }),
    );
    expect(split.values).toMatchObject({ bp_systolic: 120, bp_diastolic: 80 });
    expect(mapRecord(medicalRecordsMapper, rec({})).invalid).toBe("missing visit_date");
  });

  it("Acute Visits adopt MRD rows and add only what MRD lacks (never vitals, notes or doctor)", () => {
    const v = mapRecord(
      acuteVisitsMapper,
      rec({
        fldRPRNAgGU7aaSQe: "recMRD0001",
        fldXlyyw4yhhwby2g: "2026-09-01",
        fldfDoqBTP05oHIhJ: "Paediatrics",
        fldgZRyGr1tVmNbYk: "Not available in Unite",
        fld2al0GgsV6g4Rdi: true,
      }),
    );
    expect(v.values).toMatchObject({
      external_id: "recMRD0001",
      source: "airtable",
      department_mapped: "paediatrics",
      pap_result: "not_available",
      symptomatic: true,
    });
    for (const col of ["temp_c", "bp_systolic", "pulse", "doctor_name", "procedure_notes"])
      expect(Object.keys(v.values), col).not.toContain(col);
    expect(acuteVisitsMapper.fillBlankOnly).toContain("visit_date");
  });

  it("Prescriptions: visit link required, position parsed, Airtable class ignored (set later from the reference table)", () => {
    const p = mapRecord(
      acutePrescriptionsMapper,
      rec({
        fldPLUnLoIBIUfcfT: "recMRD0001-2",
        fldNp6WqXyDjupsue: "D-100",
        fldfujiLktvFEPNE1: "7",
        fld7K9SVDvqjaU30A: "Antibiotic",
      }),
    );
    expect(p.values).toMatchObject({
      external_key: "recMRD0001-2",
      position: 2,
      duration_days: 7,
      source: "airtable_acute",
    });
    expect(Object.keys(p.values)).not.toContain("class");
    expect(Object.keys(p.values)).not.toContain("requires_probiotics");
    expect(acutePrescriptionsMapper.createOnly).toBe(true);
    const visitLink = acutePrescriptionsMapper.links?.find(
      (l) => l.kind === "record" && l.label === "Visit",
    );
    expect(visitLink && visitLink.kind === "record" && visitLink.required).toBe(true);
  });

  it("Follow-ups: engine-incompatible source is never used; pending real rows stay open, everything else is closed", () => {
    const base = {
      fldXCi8apfSF1wGLH: "FU-1",
      fldNOnLLHzKuEapJX: "Vitals",
      fldX94COawJmYp0kb: "High",
    };
    const open = mapRecord(acuteFollowupMapper, recAt({ ...base, fldoS3vnm2UmJI21S: "Pending" }));
    expect(open.values).toMatchObject({
      source: "airtable_acute",
      trigger_category: "vitals",
      priority: "high",
      call_status: "pending",
      closed_at: null,
      closed_reason: null,
    });
    expect(open.warnings).toContain("followup_imported_open");

    const done = mapRecord(
      acuteFollowupMapper,
      recAt({ ...base, fldoS3vnm2UmJI21S: "Completed", fldwfriyDgawIslbQ: true }),
    );
    expect(done.values).toMatchObject({
      call_status: "completed",
      closed_at: CREATED,
      closed_reason: "airtable_history",
      doctor_notified_at: CREATED,
    });
    // an unrecognised status must not leave the row open in the live queue
    const odd = mapRecord(acuteFollowupMapper, recAt({ ...base, fldoS3vnm2UmJI21S: "Mystery" }));
    expect(odd.values.call_status).toBeNull();
    expect(odd.values.closed_reason).toBe("airtable_history");
    expect(odd.warnings).toContain("unknown_call_status");
    // test rows are flagged and closed
    const test = mapRecord(
      acuteFollowupMapper,
      recAt({ ...base, fldoS3vnm2UmJI21S: "Pending", fldJDp2lrt0n3YY1z: true }),
    );
    expect(test.isTest).toBe(true);
    expect(test.values.closed_reason).toBe("airtable_history");
    expect(acuteFollowupMapper.createOnly).toBe(true);
  });

  it("Feedback: stage is required, score is range-checked, notified timestamps come from checkboxes", () => {
    const f = mapRecord(
      acuteFeedbackMapper,
      recAt({
        fldRthKkY016ceRta: "FB-1",
        fldeR3gUWc5H3cRDh: "After Antibiotics",
        fld0yu7tTxBdtds2e: 4,
        fld0Hyt8i9QjKFPuB: true,
        fldq8lgUIHlHSc75b: "2026-09-06T08:00:00.000Z",
      }),
    );
    expect(f.values).toMatchObject({
      stage: "after_antibiotics",
      score: 4,
      doctor_notified_at: "2026-09-06T08:00:00.000Z",
    });
    expect(f.values.coordinator_notified_at).toBeUndefined();
    expect(Object.keys(f.values)).not.toContain("needs_doctor_review");
    expect(mapRecord(acuteFeedbackMapper, recAt({ fldRthKkY016ceRta: "FB-2" })).invalid).toBe(
      "missing stage",
    );
    const wild = mapRecord(
      acuteFeedbackMapper,
      recAt({ fldeR3gUWc5H3cRDh: "Post-Procedure", fld0yu7tTxBdtds2e: 14 }),
    );
    expect(wild.values.score).toBeNull();
    expect(wild.warnings).toContain("score_out_of_range");
  });

  it("Message log: terminal statuses only, test rows are never live, keys are required", () => {
    const base = { fldU0k0N5b3RiqfOl: "ABX_DAY3", fldYJRG3KcI8YyQbo: "recMRD0001-1:ABX_DAY3" };
    const sent = mapRecord(
      acuteMessageLogMapper,
      recAt({ ...base, fldBN7AFKvB77rHaV: "2026-09-04T09:00:00Z" }),
    );
    expect(sent.values).toMatchObject({ status: "sent", send_mode: "live" });
    const delivered = mapRecord(
      acuteMessageLogMapper,
      recAt({ ...base, fldBN7AFKvB77rHaV: "2026-09-04T09:00:00Z", fldigImLLUJ11a6ce: true }),
    );
    expect(delivered.values.status).toBe("delivered");
    const never = mapRecord(acuteMessageLogMapper, recAt(base));
    expect(never.values).toMatchObject({
      status: "cancelled",
      block_reason: "not_sent_in_airtable",
    });
    expect(never.values.status).not.toBe("scheduled");
    const test = mapRecord(
      acuteMessageLogMapper,
      recAt({ ...base, fldBN7AFKvB77rHaV: "2026-09-04T09:00:00Z", fldIICnc9N59HHUoH: true }),
    );
    expect(test.values.send_mode).toBe("test");
    expect(mapRecord(acuteMessageLogMapper, recAt({ fldYJRG3KcI8YyQbo: "k" })).invalid).toBe(
      "missing template_key",
    );
    expect(mapRecord(acuteMessageLogMapper, recAt({ fldU0k0N5b3RiqfOl: "t" })).invalid).toBe(
      "missing idempotency_key",
    );
  });

  it("Call scripts: only FU_* rows with copy; an Airtable approval is never imported", () => {
    const fu = mapRecord(
      callScriptsMapper,
      rec({
        fldgpCwM1uG424pKz: "FU_PAED_1",
        fldyfsVBI5CP4L8GM: "Hello, this is the clinic…",
        fld1lj7DaZSAaJRME: "Approved",
        fldruCMCoDqzTEtgH: "2",
      }),
    );
    expect(fu.skipReason).toBeUndefined();
    expect(fu.values).toMatchObject({ key: "FU_PAED_1", clinical_approval: "awaiting", phase: 2 });
    expect(fu.warnings).toContain("airtable_approval_not_imported");
    expect(
      mapRecord(callScriptsMapper, rec({ fldgpCwM1uG424pKz: "RX_START", fldyfsVBI5CP4L8GM: "x" }))
        .skipReason,
    ).toBe("not_a_call_script");
    expect(mapRecord(callScriptsMapper, rec({ fldgpCwM1uG424pKz: "FU_X" })).skipReason).toBe(
      "call_script_without_copy",
    );
  });
});

describe("pending mappers (validated by --dry-run only)", () => {
  it("every pending mapper says why it is not written", () => {
    for (const e of REGISTRY) {
      if (e.type !== "table" || e.mapper.status !== "pending") continue;
      expect(e.mapper.pendingReason, e.key).toBeTruthy();
    }
  });

  it("Birthday: day-first legacy dates, cycle key is the year", () => {
    const b = mapRecord(
      birthdayMapper,
      rec({ fldUYm1BW2qck0zTm: "PIN1", fldJA8wk04TfEVCAm: "25/12/2025" }),
    );
    expect(b.values).toMatchObject({
      patient_pin: "PIN1",
      sent_on: "2025-12-25",
      cycle_key: "2025",
      programme_key: "birthday",
    });
    expect(
      warnings((w) =>
        mapRecord(birthdayMapper, rec({ fldJA8wk04TfEVCAm: "someday" })).warnings.forEach(w),
      ),
    ).toContain("unparseable_sent_date");
  });

  it("Chronic recall: booked without a booking date never survives; the PHI note is dropped", () => {
    const r = mapRecord(
      chronicRecallMapper,
      rec({
        fldmqIT40DYyGAe8q: "PIN1",
        fld01KXt1biCwWS55: "2026-09-02T06:00:00.000Z",
        fldqgbYSfHGYq8LVV: "Booked",
        fldoG6VR5IIm5I2b5: "Sent to: +971500000000",
      }),
    );
    expect(r.values.follow_up_status).toBe("called");
    expect(r.values.notes).toBeNull();
    expect(r.values.cycle_key).toBe("2026-09-02");
  });

  it("Appointment messages: date-only send time becomes noon Dubai", () => {
    const a = mapRecord(
      appointmentMessagesMapper,
      rec({
        fldjRghFRS8xkpkWa: "A1",
        fld5m4VQXx6JQYAIk: "2026-09-03",
        fldlE1a7BlurxGn1c: "Birthday",
      }),
    );
    expect(a.values.sent_at).toBe("2026-09-03T08:00:00.000Z");
  });
});
