/**
 * The database side of the chronic-condition rule (Phase 21). The decision is the pure
 * deriveChronicConditions() (lib/clinical/chronic.ts); this file loads the facts (ids, dates and counts
 * only), runs the rule and hands the result to public.clinical_apply_chronic_conditions(), which writes it
 * in one statement and removes derived rows the rule no longer returns.
 *
 * Run after a visit is ingested (for that patient) and nightly for the whole organisation. While the
 * threshold is unsigned the rule derives nothing, so the writer removes every derived row (fail closed:
 * chronic recall then only sees conditions that came from Unite or the Airtable import).
 */
import {
  deriveChronicConditions,
  toApplyRows,
  type ChronicDiagnosisFact,
  type ChronicDerivation,
} from "@/lib/clinical/chronic";
import { loadClinicalSettings } from "@/lib/clinical/engine";
import type { ClinicalSettings } from "@/lib/clinical/settings";
import type { AdminClient } from "@/lib/supabase/admin";

const PAGE = 1000;

export type ChronicRunResult = {
  facts: number;
  derived: number;
  inserted: number;
  updated: number;
  removed: number;
  rejected: number;
  /** Visit diagnoses linked to a reference row that arrived later (whole-organisation runs only). */
  linked: number;
  missingSettings: string[];
  skipped: ChronicDerivation["skipped"];
};

async function loadFacts(
  admin: AdminClient,
  orgId: string,
  contactIds: string[] | null,
): Promise<ChronicDiagnosisFact[]> {
  const out: ChronicDiagnosisFact[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .rpc("clinical_chronic_facts", { p_org: orgId, p_contacts: contactIds ?? undefined })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`chronic facts failed (${error.code ?? "unknown"})`);
    for (const r of data ?? [])
      out.push({
        contactId: r.contact_id,
        refDiagnosisId: r.ref_diagnosis_id,
        chronic: r.chronic,
        visitCount: r.visit_count,
        firstVisitDate: r.first_visit_date,
        lastVisitDate: r.last_visit_date,
      });
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Derive and write chronic conditions. `contactIds` limits the run to those patients (after an ingest);
 * omitted = the whole organisation (the nightly job), which also links codes that reached the reference late.
 */
export async function deriveChronicConditionsForOrg(
  admin: AdminClient,
  orgId: string,
  opts: { contactIds?: string[]; settings?: ClinicalSettings } = {},
): Promise<ChronicRunResult> {
  const scope = opts.contactIds ? [...new Set(opts.contactIds)] : null;
  if (scope && scope.length === 0)
    return {
      facts: 0,
      derived: 0,
      inserted: 0,
      updated: 0,
      removed: 0,
      rejected: 0,
      linked: 0,
      missingSettings: [],
      skipped: {},
    };

  let linked = 0;
  if (!scope) {
    const { data, error } = await admin.rpc("clinical_resolve_visit_diagnoses", { p_org: orgId });
    if (error) throw new Error(`diagnosis linking failed (${error.code ?? "unknown"})`);
    linked = Number(data ?? 0);
  }

  const settings = opts.settings ?? (await loadClinicalSettings(admin, orgId));
  const facts = await loadFacts(admin, orgId, scope);
  const derivation = deriveChronicConditions(facts, settings);

  const { data, error } = await admin.rpc("clinical_apply_chronic_conditions", {
    p_org: orgId,
    p_rows: toApplyRows(derivation.conditions),
    p_contacts: scope ?? undefined,
  });
  if (error) throw new Error(`chronic conditions write failed (${error.code ?? "unknown"})`);
  const res = (data ?? {}) as Record<string, number>;
  return {
    facts: facts.length,
    derived: derivation.conditions.length,
    inserted: Number(res.inserted ?? 0),
    updated: Number(res.updated ?? 0),
    removed: Number(res.removed ?? 0),
    rejected: Number(res.rejected ?? 0),
    linked,
    missingSettings: derivation.missingSettings,
    skipped: derivation.skipped,
  };
}
