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
