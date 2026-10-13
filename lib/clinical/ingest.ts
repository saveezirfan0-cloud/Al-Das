import { composeObservationNotes } from "@/lib/clinical/negation";
import { PLAUSIBLE, parseBp, parseVital } from "@/lib/clinical/vitals";

/** What Unite gives us for a visit's vitals and narrative (strings, as sent). */
export type RawVisitFields = {
  bpSystolic?: string | null;
  bpDiastolic?: string | null;
  temperature?: string | null;
  pulse?: string | null;
  spo2?: string | null;
  complaints?: string | null;
  hpi?: string | null;
  doctorNotes?: string | null;
  nurseNotes?: string | null;
};

/**
 * Ingest-time parsing (R-01/R-02/R-03 composite). Values that don't parse stay null with the raw
 * strings kept in `vitalsRaw`, so a parser bug is visible, never silent.
 */
export function ingestVisitFields(raw: RawVisitFields) {
  const bp = parseBp(raw.bpSystolic, raw.bpDiastolic);
  return {
    tempC: parseVital(raw.temperature, PLAUSIBLE.temp),
    pulse: parseVital(raw.pulse, PLAUSIBLE.pulse),
    spo2: parseVital(raw.spo2, PLAUSIBLE.spo2),
    bpSystolic: bp.systolic,
    bpDiastolic: bp.diastolic,
    vitalsRaw: {
      bp_systolic: raw.bpSystolic ?? null,
      bp_diastolic: raw.bpDiastolic ?? null,
      temperature: raw.temperature ?? null,
      pulse: raw.pulse ?? null,
      spo2: raw.spo2 ?? null,
    },
    observationNotesRaw: composeObservationNotes({
      complaints: raw.complaints,
      hpi: raw.hpi,
      doctorNotes: raw.doctorNotes,
      nurseNotes: raw.nurseNotes,
    }),
  };
}

/**
 * ICD-10(-CM) as Unite and the Airtable Diagnosis table write it: a letter, a digit, a character, then
 * up to four more characters with or without the dot ("I10", "E11.9", "E119", "S72.001A").
 */
const ICD10 = /^[A-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/;

export type IngestedDiagnosis = { code: string; isPrimary: boolean };

/**
 * Phase 21: the diagnosis codes of one visit, ready for public.clinical_store_visit_diagnoses().
 * Codes are trimmed and upper-cased; duplicates collapse (primary wins); anything that is not an ICD-10
 * shape is dropped and counted, never guessed. The primary code is added if it is missing from the list.
 */
export function ingestDiagnosisCodes(raw: {
  primary?: string | null;
  codes?: ReadonlyArray<string | null | undefined> | null;
}): { diagnoses: IngestedDiagnosis[]; rejected: number } {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
  const out = new Map<string, IngestedDiagnosis>();
  let rejected = 0;
  const add = (value: string | null | undefined, isPrimary: boolean) => {
    const code = norm(value);
    if (!code) return;
    if (!ICD10.test(code)) {
      rejected++;
      return;
    }
    const prev = out.get(code);
    out.set(code, { code, isPrimary: isPrimary || !!prev?.isPrimary });
  };
  add(raw.primary, true);
  for (const c of raw.codes ?? []) add(c, false);
  return { diagnoses: [...out.values()], rejected };
}
