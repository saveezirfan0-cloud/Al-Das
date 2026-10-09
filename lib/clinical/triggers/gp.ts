import { containsAny, isBlank } from "@/lib/clinical/text";
import { hasInv, type RuleCtx, type RuleResult } from "@/lib/clinical/triggers/facts";

/**
 * R-GP (gate: department effective = gp). Each OR-term of GP-01 is evaluated on its own setting:
 * an unsigned threshold switches only its term off, so a signed one still catches its vital.
 */
export function gpRules({ facts: f, need }: RuleCtx): RuleResult {
  const fired: string[] = [];

  const fever = need.num("adult_fever_temp_c");
  const sysLow = need.num("adult_bp_systolic_low");
  const diaLow = need.num("adult_bp_diastolic_low");
  const spo2Low = need.num("spo2_low_pct");
  const pulseHigh = need.num("adult_pulse_high");
  if (
    (fever !== undefined && f.tempC !== null && f.tempC >= fever) ||
    (sysLow !== undefined && f.bpSystolic !== null && f.bpSystolic < sysLow) ||
    (diaLow !== undefined && f.bpDiastolic !== null && f.bpDiastolic < diaLow) ||
    (spo2Low !== undefined && f.spo2 !== null && f.spo2 <= spo2Low) ||
    (pulseHigh !== undefined && f.pulse !== null && f.pulse >= pulseHigh)
  )
    fired.push("GP-01-VITALS");

  // Reads scrubbed notes only: "denies chest pain" must not flag.
  const redFlags = need.list("gp02_redflag_terms");
  if (redFlags && containsAny(`${f.dx} ${f.obs}`, redFlags)) fired.push("GP-02-REDFLAG");

  const infections = need.list("gp03_infection_terms");
  if (infections && containsAny(f.dx, infections) && hasInv(f)) fired.push("GP-03");

  if (!isBlank(f.proc)) fired.push("GP-04-PROC");

  if (f.hasAntibiotic || f.hasSteroid) fired.push("GP-05-MEDS");

  const planTerms = need.list("gp06_plan_terms");
  if (planTerms && containsAny(f.plan, planTerms)) fired.push("GP-06");

  return { fired };
}
