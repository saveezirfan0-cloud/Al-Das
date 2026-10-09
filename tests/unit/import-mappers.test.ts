/**
 * Mapper tests use SYNTHETIC records only (CLAUDE.md rule 10).
 */
import { describe, expect, it } from "vitest";

import { acutePatientsMapper, F as A } from "../../scripts/import/mappers/airtable.acute-patients";
import { unitePatientsMapper, F as U } from "../../scripts/import/mappers/airtable.unite-patients";
import {
  findSanoflowIdHeader,
  sanoflowMapping,
} from "../../scripts/import/mappers/sanoflow.contacts";
import { splitName } from "../../scripts/import/mappers/types";
import { PATIENT_MAPPERS } from "../../scripts/import/mappers";

describe("Unite patients mapper", () => {
  it("maps a full synthetic record", () => {
    const m = unitePatientsMapper.map({
      id: "recTEST000000001",
      fields: {
        [U.patientName]: "Test Patient Example",
        [U.patientPin]: "PIN-0001",
        [U.sanoflowContactId]: "sf-42",
        [U.phone]: "971-501234567",
        [U.email]: "Test@Example.test",
        [U.nationalitySelect]: "United Arab Emirates",
        [U.gender]: "F",
        [U.dob]: "1990-10-10",
        [U.address]: "Somewhere 1",
        [U.insurancePlan]: "AXA",
        [U.clinic]: "Al Das Medical Clinic - Meadows",
        [U.departmentSelect]: "General",
        [U.drName]: "Dr. Example",
        [U.firstVisit]: "2024-01-05",
        [U.lastVisit]: "2026-09-01",
        [U.chronicRecallSentOn]: "2026-09-20",
        [U.chronicRecallCondition]: "Hypertension / Hypertensive disease",
        [U.birthdayMessage]: "Sent",
        [U.nmdr25]: true,
      },
    });
    expect(m.recordId).toBe("recTEST000000001");
    expect(m.contact).toMatchObject({
      first_name: "Test",
      last_name: "Patient Example",
      external_id: "PIN-0001",
      phone_e164: "+971501234567",
      country: "AE",
      email: "test@example.test",
      nationality: "United Arab Emirates",
      gender: "female",
      dob: "1990-10-10",
      source: "import_airtable",
      custom: {
        address: "Somewhere 1",
        insurance_plan: "axa",
        clinic: "meadows",
        department: "General",
        doctor_name: "Dr. Example",
        first_visit_date: "2024-01-05",
        last_visit_date: "2026-09-01",
      },
    });
    expect(m.refs).toEqual({ sanoflow: "sf-42" });
    expect(m.meta).toMatchObject({
      chronic_recall_sent_on: "2026-09-20",
      chronic_recall_condition: "Hypertension / Hypertensive disease",
      birthday_message: "Sent",
      nmdr_25: true,
    });
    expect(m.warnings).toEqual([]);
    expect(m.isTestRecord).toBe(false);
  });

  it("warns on bad data but still returns an identifiable contact", () => {
    const m = unitePatientsMapper.map({
      id: "rec2",
      fields: {
        [U.patientName]: "Solo",
        [U.patientPin]: "PIN-2",
        [U.phone]: "12",
        [U.email]: "nope",
        [U.dob]: "31/02/2020",
        [U.gender]: "Z",
      },
    });
    expect(m.contact.first_name).toBe("Solo");
    expect(m.contact.last_name).toBe("");
    expect(m.contact.phone_e164).toBeNull();
    expect(m.contact.email).toBeNull();
    expect(m.contact.dob).toBeNull();
    expect(m.contact.gender).toBe("unknown");
    expect(m.warnings.sort()).toEqual(["invalid dob", "invalid email", "invalid phone"]);
  });

  it("never emits a Unite field as a custom key it did not declare", () => {
    const declared = new Set(unitePatientsMapper.customFields.map((f) => f.key));
    const m = unitePatientsMapper.map({
      id: "rec3",
      fields: {
        [U.patientName]: "A B",
        [U.address]: "x",
        [U.clinic]: "unknown clinic",
        [U.insurancePlan]: "Other",
      },
    });
    for (const k of Object.keys(m.contact.custom)) expect(declared.has(k)).toBe(true);
    expect(m.contact.custom).toEqual({ address: "x" });
  });
});

describe("Acute patients mapper", () => {
  it("maps consent, language and the test flag", () => {
    const m = acutePatientsMapper.map({
      id: "recA1",
      fields: {
        [A.patientId]: "PIN-0001",
        [A.fullName]: "Test Patient",
        [A.mobile]: "0501234567",
        [A.dob]: "10/10/1990",
        [A.gender]: "Male",
        [A.whatsappConsent]: true,
        [A.language]: "Arabic",
        [A.isTestRecord]: true,
      },
    });
    expect(m.contact).toMatchObject({
      external_id: "PIN-0001",
      first_name: "Test",
      last_name: "Patient",
      phone_e164: "+971501234567",
      dob: "1990-10-10",
      gender: "male",
      promotions_opt_in: true,
      language: "ar",
      custom: { is_test_record: true },
    });
    expect(m.isTestRecord).toBe(true);
  });

  it("leaves consent unknown when the box is unchecked (never clears an opt-in)", () => {
    const m = acutePatientsMapper.map({
      id: "recA2",
      fields: { [A.patientId]: "PIN-9", [A.fullName]: "X Y" },
    });
    expect(m.contact.promotions_opt_in).toBeNull();
    expect(m.contact.custom).toEqual({});
  });
});

describe("mapper registry", () => {
  it("has unique table ids and declared field ids", () => {
    const keys = PATIENT_MAPPERS.map((m) => `${m.baseId}.${m.tableId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of PATIENT_MAPPERS)
      for (const id of m.fieldIds) expect(id).toMatch(/^fld[A-Za-z0-9]{14}$/);
  });

  it("splits names like the Airtable formulas", () => {
    expect(splitName("  Amina   Al Test ")).toEqual({ first: "Amina", last: "Al Test" });
    expect(splitName("Mono")).toEqual({ first: "Mono", last: "" });
    expect(splitName("")).toEqual({ first: "", last: "" });
  });
});

describe("Sanoflow CSV mapping", () => {
  it("recognises Sanoflow export headers and the id column", () => {
    const headers = [
      "Contact Id",
      "Contact Name",
      "Phone Number",
      "Alternate Contacts",
      "Email",
      "Gender",
      "Nationality",
      "Date Of Birth",
      "Promotions Opt-In",
      "Stop Marketing",
      "Tags",
      "Source",
      "Created At",
      "Insurance plan",
    ];
    const m = sanoflowMapping(headers, [{ key: "insurance_plan", label: "Insurance plan" }]);
    expect(m).toMatchObject({
      "Contact Name": "full_name",
      "Phone Number": "phone",
      "Alternate Contacts": "alternate_phones",
      Email: "email",
      Gender: "gender",
      "Date Of Birth": "dob",
      "Promotions Opt-In": "promotions_opt_in",
      "Stop Marketing": "stop_marketing",
      Tags: "tags",
      Source: "source",
      "Created At": null,
      "Insurance plan": "custom.insurance_plan",
    });
    expect(findSanoflowIdHeader(headers)).toBe("Contact Id");
    expect(findSanoflowIdHeader(["Name", "Phone"])).toBeNull();
  });
});
