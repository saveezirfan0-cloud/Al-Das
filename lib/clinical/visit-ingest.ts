/**
 * The clinical ingest path, database side (Phase 21). A visit feed (the Unite visits sync once Unite documents
 * the endpoint; today only tests and the Airtable importer write visits) stores a visit and its prescriptions,
 * then calls:
 *
 *   1. storeVisitDiagnoses()  the visit's ICD-10 codes, normalised by ingestDiagnosisCodes(), replaced
 *                             idempotently in visit_diagnoses and linked to ref_diagnoses when known;
 *   2. afterVisitIngest()     re-derives the patient's chronic conditions and plans sequences for any new
 *                             antibiotic prescription.
 *
 * Nothing here sends a message. Codes and ids only are logged by callers; never notes or names.
 */
import { deriveChronicConditionsForOrg, type ChronicRunResult } from "@/lib/clinical/chronic-store";
import { ingestDiagnosisCodes } from "@/lib/clinical/ingest";
import { planPendingSequences, type PlanResult } from "@/lib/clinical/sequence-store";
import type { AdminClient } from "@/lib/supabase/admin";

export type StoredDiagnoses = {
  codes: number;
  written: number;
  removed: number;
  /** Codes with no row in the Diagnosis reference (shown on the Data quality screen). */
  unknown: number;
  /** Values that were not an ICD-10 code and were dropped. */
  rejected: number;
};

export async function storeVisitDiagnoses(
  admin: AdminClient,
  orgId: string,
  visitId: string,
  raw: { primary?: string | null; codes?: ReadonlyArray<string | null | undefined> | null },
  source: "unite" | "airtable" | "manual" = "unite",
): Promise<StoredDiagnoses> {
  const { diagnoses, rejected } = ingestDiagnosisCodes(raw);
  const { data, error } = await admin.rpc("clinical_store_visit_diagnoses", {
    p_org: orgId,
    p_visit: visitId,
    p_codes: diagnoses.map((d) => ({ code: d.code, is_primary: d.isPrimary })),
    p_source: source,
  });
  if (error) throw new Error(`visit diagnoses write failed (${error.code ?? "unknown"})`);
  const r = (data ?? {}) as Record<string, number>;
  return {
    codes: Number(r.codes ?? 0),
    written: Number(r.written ?? 0),
    removed: Number(r.removed ?? 0),
    unknown: Number(r.unknown ?? 0),
    rejected,
  };
}

/** Post-ingest work for one visit: the patient's chronic conditions, then any new antibiotic sequence. */
export async function afterVisitIngest(
  admin: AdminClient,
  orgId: string,
  visitId: string,
  now: Date = new Date(),
): Promise<{ chronic: ChronicRunResult | null; sequences: PlanResult }> {
  const { data: visit } = await admin
    .from("visits")
    .select("contact_id")
    .eq("id", visitId)
    .eq("org_id", orgId)
    .maybeSingle();
  const chronic = visit?.contact_id
    ? await deriveChronicConditionsForOrg(admin, orgId, { contactIds: [visit.contact_id] })
    : null;
  const sequences = await planPendingSequences(admin, orgId, { now, limit: 50 });
  return { chronic, sequences };
}
