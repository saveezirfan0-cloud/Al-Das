/**
 * Everything the importer knows about: patient tables, generic table mappers and the tables that
 * are deliberately not imported (with the reason). Listing order is the default run order; it
 * follows docs/audit/data-model-mapping.md §8 and is then adjusted by dependsOn.
 */
import { acutePatientsMapper } from "./mappers/airtable.acute-patients";
import { unitePatientsMapper } from "./mappers/airtable.unite-patients";
import type { PatientMapper } from "./mappers/types";
import { BASE } from "./tables/bases";
import {
  acuteFeedbackMapper,
  acuteFollowupMapper,
  acuteMessageLogMapper,
  acutePrescriptionsMapper,
  acuteVisitsMapper,
  callScriptsMapper,
  doctorsMapper,
  medicalRecordsMapper,
} from "./tables/clinical";
import {
  appointmentMessagesMapper,
  birthdayMapper,
  chronicRecallMapper,
} from "./tables/pending-logs";
import {
  cptMasterMapper,
  diagnosisMapper,
  itemsMapper,
  medicationMapper,
  medicationReferenceMapper,
  settingsMapper,
  websiteMapper,
} from "./tables/reference";
import type { TableMapper } from "./tables/types";

export type PatientEntry = {
  type: "patients";
  key: string;
  mapper: PatientMapper;
  dependsOn: string[];
};
export type TableEntry = { type: "table"; key: string; mapper: TableMapper; dependsOn: string[] };
export type SkipEntry = {
  type: "skip";
  key: string;
  name: string;
  baseId: string;
  tableId: string;
  reason: string;
};
export type RegistryEntry = PatientEntry | TableEntry | SkipEntry;

const patient = (key: string, mapper: PatientMapper, dependsOn: string[] = []): PatientEntry => ({
  type: "patients",
  key,
  mapper,
  dependsOn,
});
const table = (mapper: TableMapper): TableEntry => ({
  type: "table",
  key: mapper.key,
  mapper,
  dependsOn: mapper.dependsOn ?? [],
});

export const REGISTRY: readonly RegistryEntry[] = [
  // 1. references
  table(diagnosisMapper),
  table(medicationMapper),
  table(itemsMapper),
  table(cptMasterMapper),
  table(medicationReferenceMapper),
  table(settingsMapper),
  // 2. staff / places
  table(doctorsMapper),
  // 3. patients
  patient("unite.patients", unitePatientsMapper),
  patient("acute.patients", acutePatientsMapper, ["unite.patients"]),
  // 4. visits, prescriptions
  table(medicalRecordsMapper),
  table(acuteVisitsMapper),
  table(acutePrescriptionsMapper),
  // 5. follow-ups, feedback, logs
  table(acuteFollowupMapper),
  table(acuteFeedbackMapper),
  table(acuteMessageLogMapper),
  table(appointmentMessagesMapper),
  table(birthdayMapper),
  table(chronicRecallMapper),
  // 6. config
  table(websiteMapper),
  table(callScriptsMapper),
  // deliberately not imported
  {
    type: "skip",
    key: "acute.test_plan",
    name: "Acute · Test Plan",
    baseId: BASE.acute,
    tableId: "tbl2xmInmphVGkkFY",
    reason:
      "Becomes unit-test fixtures (tests/fixtures/clinical/*.json); result fields are dropped.",
  },
  {
    type: "skip",
    key: "ptf.patients",
    name: "PTF · Patients",
    baseId: BASE.ptf,
    tableId: "tbl9856qJP9S7OEqB",
    reason:
      "Same field ids as Unite.Unite; the Unite base wins. Language / consent fill-ins are a Phase 6 follow-up.",
  },
  {
    type: "skip",
    key: "ptf.laboratory",
    name: "PTF · Laboratory & Diagnostic Test",
    baseId: BASE.ptf,
    tableId: "tbl6LX9OJu8lBwSgf",
    reason: "Backlog (P2) lab_orders table; field map is recorded in data-model-mapping.md §5.3.",
  },
  {
    type: "skip",
    key: "ptf.prescriptions",
    name: "PTF · Prescriptions",
    baseId: BASE.ptf,
    tableId: "tblRNJcasTIz0vLhR",
    reason:
      "Prototype base (mostly test data, confirmed): its patient links point at PTF's own Patients table, which is not imported. Field map is in data-model-mapping.md §5.2 if real history turns up.",
  },
  {
    type: "skip",
    key: "ptf.feedback",
    name: "PTF · Feedback & Outcomes",
    baseId: BASE.ptf,
    tableId: "tbleAP5BLA6Juf8B1",
    reason:
      "Prototype base (mostly test data, confirmed). Mapping is in data-model-mapping.md §5.5 if real history turns up.",
  },
  {
    type: "skip",
    key: "ptf.whatsapp_log",
    name: "PTF · Whatsapp Automation Log",
    baseId: BASE.ptf,
    tableId: "tbl5wvAX6GidMm7n3",
    reason:
      "Prototype base (mostly test data, confirmed). Mapping is in data-model-mapping.md §5.4 if real history turns up.",
  },
  {
    type: "skip",
    key: "ptf.patient_visits",
    name: "PTF · Patient Visits",
    baseId: BASE.ptf,
    tableId: "tbldH45nIL5EQAjpy",
    reason:
      "Prototype base; visit feedback (5-star) is a backlog table with no target yet (data-model-mapping.md §5.8).",
  },
  {
    type: "skip",
    key: "cfu.followup_queue",
    name: "CFU · Follow-Up Queue",
    baseId: BASE.cfu,
    tableId: "tblJvIh3Wf7z8Qn8k",
    reason:
      "Superseded prototype (confirmed mostly test data). Its escalation and doctor-response fields are already modelled on clinical_followups; mapping is in data-model-mapping.md §4.1.",
  },
  ...[
    ["tblFQn2YMbmoqa6HF", "Post-Visit Follow-Up"],
    ["tblrQgE70HzqJYw2n", "No-Show Recovery"],
    ["tblF3lIUbACqMeEO5", "Patient Retention Alerts"],
    ["tblDW9nZ8CO7ay0nJ", "Symptom Triage Log"],
    ["tblLFZxm2DLOQyX2H", "Payment Collection"],
    ["tblsGOqQIaB3JsMIQ", "Insurance Verification"],
    ["tblUV2xClsjzRJ5qU", "Conversation Analytics"],
  ].map(([tableId, name]): SkipEntry => ({
    type: "skip",
    key: `ptf.draft.${name.toLowerCase().replace(/[^a-z]+/g, "_")}`,
    name: `PTF · ${name} (DRAFT)`,
    baseId: BASE.ptf,
    tableId,
    reason:
      "Requirements-only draft table (data-model-mapping.md §5.9); redesigned natively, not migrated.",
  })),
];

export function entityMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of REGISTRY) {
    if (e.type === "patients") m.set(e.key, `${e.mapper.baseId}.${e.mapper.tableId}`);
    else if (e.type === "table") m.set(e.key, `${e.mapper.baseId}.${e.mapper.tableId}`);
  }
  return m;
}
