import { acutePatientsMapper } from "./airtable.acute-patients";
import { unitePatientsMapper } from "./airtable.unite-patients";
import type { PatientMapper } from "./types";

/** Phase 2 scope: patient-related tables. Phase 9 adds visits, reference tables and portal objects. */
export const PATIENT_MAPPERS: readonly PatientMapper[] = [unitePatientsMapper, acutePatientsMapper];

export type { MappedPatient, PatientMapper } from "./types";
