/**
 * Synthetic Airtable records for the clinical import chain (doctors, visits, prescriptions,
 * follow-ups, feedback, message log, call scripts). Shared by the in-memory and real-schema tests.
 * No real patient data: every id and value is made up.
 */
import type { AirtableRecord } from "../../scripts/import/airtable-client";

const MRD = "app7QJ2pvhADHQeBP.tblllKPKIY9qvMoEU";

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

const A = "appH2jHpsNR1nqEQ2";
export const CLINICAL_TABLES = {
  doctors: "appZbwlQvkuaUsF2l.tblhoMqQ1jgiCGHGY",
  visits: `${A}.tblyOweSP3FfeY9q0`,
  rx: `${A}.tblQra08AflxuXxQq`,
  fu: `${A}.tblgX6wIqWefpwrBg`,
  fb: `${A}.tbluNXftGwkP9rJDV`,
  log: `${A}.tblXNWAh1hdaueUbs`,
  tpl: `${A}.tblnCsSkyw4Tu9Ak7`,
};
export const CLINICAL_CHAIN = [
  "ptf.doctors",
  "unite.patients",
  "acute.patients",
  "unite.medical_records",
  "acute.visits",
  "acute.prescriptions",
  "acute.followup_queue",
  "acute.feedback",
  "acute.message_log",
  "acute.message_templates",
];

export const CLINICAL_DATA: Record<string, AirtableRecord[]> = {
  [CLINICAL_TABLES.doctors]: [
    rec("recDoc1", { fld0ghl5SVDzYlwU0: "Dr Fake", fldkfam3qESHnrbTr: "Dermatology" }),
  ],
  [MRD]: [
    rec("recMRD1", {
      fldKuI5eXoDJIiOcu: "2026-09-01",
      fldQEoJfTLKODHoq7: "92/61",
      fldQWA9jjupL6EF3L: "38.2",
      fldtxNjAanspw8h40: ["recP1"],
      fldZiy0HG9KGApOtc: "Dr Fake",
    }),
    rec("recMRD2", { fldKuI5eXoDJIiOcu: "2026-09-02" }),
  ],
  [CLINICAL_TABLES.visits]: [
    rec("recAV1", {
      fldRPRNAgGU7aaSQe: "recMRD1",
      fldXlyyw4yhhwby2g: "2026-09-01",
      fldfDoqBTP05oHIhJ: "Paediatrics",
      fldgZRyGr1tVmNbYk: "Not available in Unite",
    }),
  ],
  [CLINICAL_TABLES.rx]: [
    rec("recRX1", {
      fldPLUnLoIBIUfcfT: "recMRD1-1",
      fldNp6WqXyDjupsue: "D-100",
      fldYBAQSnbjTmxsq0: ["recAV1"],
      fldYe4toZohBlfMrg: ["recP1"],
      fld7K9SVDvqjaU30A: "Antibiotic",
    }),
    rec("recRX2", {
      fldPLUnLoIBIUfcfT: "recMRD1-2",
      fldNp6WqXyDjupsue: "D-999",
      fldYBAQSnbjTmxsq0: ["recAV1"],
      fld7K9SVDvqjaU30A: "Antibiotic",
    }),
    rec("recRX3", { fldPLUnLoIBIUfcfT: "recMRD2-1", fldNp6WqXyDjupsue: "D-100" }), // no visit
  ],
  [CLINICAL_TABLES.fu]: [
    rec("recFU1", {
      fldXCi8apfSF1wGLH: "FU-1",
      fldNOnLLHzKuEapJX: "Vitals",
      fldX94COawJmYp0kb: "High",
      fldoS3vnm2UmJI21S: "Pending",
      fldZouRo0kxRzIB80: ["recAV1"],
      fldckx3vmXjysOFzf: "Nurse",
    }),
    rec("recFU2", {
      fldXCi8apfSF1wGLH: "FU-2",
      fldNOnLLHzKuEapJX: "Bleeding",
      fldoS3vnm2UmJI21S: "Completed",
      fldwfriyDgawIslbQ: true,
      fldZouRo0kxRzIB80: ["recAV1"],
    }),
  ],
  [CLINICAL_TABLES.fb]: [
    rec("recFB1", {
      fldRthKkY016ceRta: "FB-1",
      fldeR3gUWc5H3cRDh: "After Antibiotics",
      fld0yu7tTxBdtds2e: 8,
      fldmRIAqu1fLwd44F: ["recRX1"],
      fld5DKPuB27ioYfn9: ["recAV1"],
    }),
  ],
  [CLINICAL_TABLES.log]: [
    rec("recML1", {
      fldU0k0N5b3RiqfOl: "ABX_DAY3",
      fldYJRG3KcI8YyQbo: "recMRD1-1:ABX_DAY3",
      fldBN7AFKvB77rHaV: "2026-09-04T09:00:00.000Z",
      fldrdxterwqjkh020: ["recRX1"],
    }),
  ],
  [CLINICAL_TABLES.tpl]: [
    rec("recT1", {
      fldgpCwM1uG424pKz: "FU_PAED_1",
      fldyfsVBI5CP4L8GM: "Hello, this is the clinic.",
      fld1lj7DaZSAaJRME: "Approved",
    }),
    rec("recT2", { fldgpCwM1uG424pKz: "RX_START", fldyfsVBI5CP4L8GM: "Template copy" }),
  ],
};
