import { containsAny, containsTerm, isBlank } from "@/lib/clinical/text";
import type { RuleCtx, RuleResult } from "@/lib/clinical/triggers/facts";

/**
 * R-GYN (gate: department effective = gynaecology). Imaging / structural findings never trigger on
 * their own (OQ-10) and the Pap rule needs a structured POSITIVE result (OQ-11/12): there is no
 * fallback to "every smear".
 */
export function gynRules({ facts: f, need }: RuleCtx): RuleResult {
  const fired: string[] = [];
  const dxObs = `${f.dx} ${f.obs}`;

  // Coded fields only.
  const bleed = need.list("gyn01_bleed_terms");
  if (bleed && containsAny(`${f.dx} ${f.dx2}`, bleed)) fired.push("GYN-01-BLEED");

  const contactBleed = need.list("gyn02_bleed_terms");
  if (contactBleed && containsAny(f.obs, contactBleed)) fired.push("GYN-02-BLEED");

  if (
    containsTerm(f.obs, "spotting") &&
    (containsTerm(f.obs, "pain") || containsTerm(f.obs, "fatigue"))
  )
    fired.push("GYN-03");

  const infObs = need.list("gyn04_obs_terms");
  const infInv = need.list("gyn04_investigation_terms");
  const infDx = need.list("gyn04_diagnosis_terms");
  if (
    (infObs && containsAny(f.obs, infObs)) ||
    (infInv && containsAny(f.inv, infInv)) ||
    (infDx && containsAny(f.dx, infDx))
  )
    fired.push("GYN-04-INFECT");

  const pain = need.list("gyn05_pain_terms");
  const structural = need.list("gyn05_structural_terms");
  const symptoms = need.list("gyn05_symptom_terms");
  if (
    (pain && containsAny(dxObs, pain)) ||
    (structural && symptoms && containsAny(dxObs, structural) && containsAny(dxObs, symptoms))
  )
    fired.push("GYN-05-PAIN");

  const sysLow = need.num("gyn_bp_systolic_low");
  const pulseHigh = need.num("gyn_pulse_high");
  if (
    (sysLow !== undefined &&
      f.bpSystolic !== null &&
      f.bpSystolic < sysLow &&
      f.symptomatic === true) ||
    (pulseHigh !== undefined &&
      f.pulse !== null &&
      f.pulse >= pulseHigh &&
      (containsTerm(dxObs, "pain") || containsTerm(dxObs, "bleed"))) ||
    (containsTerm(f.obs, "fatigue") && containsTerm(f.obs, "bleed"))
  )
    fired.push("GYN-06-VITALS");

  const procTerms = need.list("gyn07_proc_terms");
  if (!isBlank(f.proc) && procTerms && containsAny(f.proc, procTerms)) fired.push("GYN-07-PROC");

  if (containsTerm(f.proc, "pap") && f.papResult === "positive") fired.push("GYN-08-PAP");

  const planTerms = need.list("gyn09_plan_terms");
  if (planTerms && containsAny(f.plan, planTerms)) fired.push("GYN-09");

  return { fired };
}
