import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REGISTRY } from "../../scripts/import/registry";
import { entityOf, mapRecord, mapperFieldIds } from "../../scripts/import/tables/map";
import {
  acuteFollowupMapper,
  medicalRecordsMapper,
  acutePrescriptionsMapper,
} from "../../scripts/import/tables/pending-clinical";
import {
  birthdayMapper,
  chronicRecallMapper,
  appointmentMessagesMapper,
  messageTemplatesMapper,
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

describe("pending (Phase 6) mappers", () => {
  it("Medical Records: BP strings, blank numerics stay null, the patient link is captured", () => {
    const m = mapRecord(
      medicalRecordsMapper,
      rec({
        fldKuI5eXoDJIiOcu: "2026-09-01",
        fldQEoJfTLKODHoq7: "92/61",
        fldQWA9jjupL6EF3L: "38.2",
        fldOVaKPQc3VUwJnh: "",
        fldtxNjAanspw8h40: ["recPATIENT000001"],
      }),
    );
    expect(m.values).toMatchObject({
      visit_date: "2026-09-01",
      bp_systolic: 92,
      bp_diastolic: 61,
      temp_c: 38.2,
      pulse: null,
    });
    expect(m.links.fldtxNjAanspw8h40).toEqual(["recPATIENT000001"]);
    const split = mapRecord(
      medicalRecordsMapper,
      rec({ fldKuI5eXoDJIiOcu: "2026-09-01", fldQEoJfTLKODHoq7: "120", fldz0AtfcKuYy52FV: "80" }),
    );
    expect(split.values).toMatchObject({ bp_systolic: 120, bp_diastolic: 80 });
    expect(
      mapRecord(
        medicalRecordsMapper,
        rec({ fldKuI5eXoDJIiOcu: "2026-09-01", fldz0AtfcKuYy52FV: "88/59" }),
      ).values,
    ).toMatchObject({ bp_systolic: 88, bp_diastolic: 59 });
    const none = mapRecord(medicalRecordsMapper, rec({ fldKuI5eXoDJIiOcu: "2026-09-01" }));
    expect(none.values).toMatchObject({ bp_systolic: null, bp_diastolic: null });
  });

  it("Prescriptions: unknown medication classes are unclassified (fail closed)", () => {
    const p = (cls: unknown) =>
      mapRecord(
        acutePrescriptionsMapper,
        rec({ fldPLUnLoIBIUfcfT: "recX-1", fld7K9SVDvqjaU30A: cls }),
      ).values.class;
    expect(p({ name: "Antibiotic" })).toBe("antibiotic");
    expect(p("Mystery")).toBe("unclassified");
    expect(p(undefined)).toBe("unclassified");
  });

  it("Follow-up queue: test rows are flagged, priority and status become enum keys", () => {
    const f = mapRecord(
      acuteFollowupMapper,
      rec({
        fldXCi8apfSF1wGLH: "FU-1",
        fldX94COawJmYp0kb: "High",
        fldJDp2lrt0n3YY1z: true,
        fldNOnLLHzKuEapJX: "Paediatric High-Concern",
      }),
    );
    expect(f.isTest).toBe(true);
    expect(f.values).toMatchObject({
      priority: "high",
      trigger_category: "paediatric_high_concern",
    });
    expect(
      mapRecord(
        acuteFollowupMapper,
        rec({ fldXCi8apfSF1wGLH: "FU-2", fldNOnLLHzKuEapJX: "Mystery" }),
      ).warnings,
    ).toContain("unknown_trigger_category");
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
      mapRecord(birthdayMapper, rec({ fldUYm1BW2qck0zTm: "PIN1", fldJA8wk04TfEVCAm: "someday" }))
        .warnings,
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
    const ok = mapRecord(
      chronicRecallMapper,
      rec({
        fldmqIT40DYyGAe8q: "PIN1",
        fld01KXt1biCwWS55: "2026-09-02T06:00:00.000Z",
        fldqgbYSfHGYq8LVV: "Booked",
        fldhv2BcULV9m5k97: "2026-09-10",
      }),
    );
    expect(ok.values.follow_up_status).toBe("booked");
  });

  it("Appointment messages: date-only send time becomes noon Dubai; birthday rows are rerouted", () => {
    const a = mapRecord(
      appointmentMessagesMapper,
      rec({
        fldjRghFRS8xkpkWa: "A1",
        fld5m4VQXx6JQYAIk: "2026-09-03",
        fldlE1a7BlurxGn1c: "Birthday",
      }),
    );
    expect(a.values.sent_at).toBe("2026-09-03T08:00:00.000Z");
    expect(a.values.target_override).toBe("recall_sends");
  });

  it("Message templates: FU_ call scripts are rerouted, clinical approval defaults to awaiting", () => {
    const t = mapRecord(messageTemplatesMapper, rec({ fldgpCwM1uG424pKz: "FU_PAED_1" }));
    expect(t.values.target_override).toBe("clinical_call_scripts");
    expect(t.values.clinical_approval).toBe("awaiting");
    expect(
      mapRecord(
        messageTemplatesMapper,
        rec({ fldgpCwM1uG424pKz: "RX_START", fld1lj7DaZSAaJRME: "Approved" }),
      ).values.clinical_approval,
    ).toBe("approved");
  });
});
