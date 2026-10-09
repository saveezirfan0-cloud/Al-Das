import { containsAny, containsTerm } from "@/lib/clinical/text";
import { hasInv, type RuleCtx, type RuleResult } from "@/lib/clinical/triggers/facts";

/**
 * R-PAED (gate: department effective = paediatrics). Seizure / febrile seizure / convulsion are
 * deliberately excluded: no rule, no automated action (OQ-09, TP-01).
 */
export function paedsRules({ facts: f, need }: RuleCtx): RuleResult {
  const fired: string[] = [];
  const dxObs = `${f.dx} ${f.obs}`;

  const feverC = need.num("paeds_fever_temp_c");
  if (feverC !== undefined && f.tempC !== null && f.tempC >= feverC) fired.push("PAED-01");

  // Do not simplify to a single temperature: the infant rule is lower AND age-gated.
  const infantC = need.num("infant_fever_temp_c");
  const infantAge = need.num("infant_age_cutoff_years");
  if (
    infantC !== undefined &&
    infantAge !== undefined &&
    f.tempC !== null &&
    f.tempC >= infantC &&
    f.ageAtVisit !== null &&
    f.ageAtVisit < infantAge
  )
    fired.push("PAED-02-INFANT");

  if (
    (containsTerm(f.dx, "fever") || containsTerm(f.obs, "fever")) &&
    (containsTerm(f.obs, "unwell") || containsTerm(f.obs, "lethargic"))
  )
    fired.push("PAED-03");

  const spo2Low = need.num("spo2_low_pct");
  if (spo2Low !== undefined && f.spo2 !== null && f.spo2 <= spo2Low) fired.push("PAED-04");

  const resp = need.list("paed05_respiratory_terms");
  if (resp && containsAny(dxObs, resp)) fired.push("PAED-05");

  const gi = need.list("paed06_gi_terms");
  const dehydration = need.list("paed06_dehydration_terms");
  if (gi && dehydration && containsAny(dxObs, gi) && containsAny(f.obs, dehydration))
    fired.push("PAED-06");

  const infections = need.list("paed07_infection_terms");
  if (infections && containsAny(f.dx, infections)) fired.push("PAED-07");

  if (hasInv(f)) fired.push("PAED-08");

  const planTerms = need.list("paed09_plan_terms");
  if (planTerms && containsAny(f.plan, planTerms)) fired.push("PAED-09");

  return { fired };
}
