import { Needs } from "@/lib/clinical/settings";
import { containsAny, isBlank } from "@/lib/clinical/text";
import { hasInv, type VisitFacts } from "@/lib/clinical/triggers/facts";
import type { Department } from "@/lib/clinical/department";

export type TriggerCategory =
  | "paediatric_high_concern"
  | "bleeding"
  | "vitals"
  | "infection_labs"
  | "post_procedure"
  | "clinical_check";

export const URGENT_CATEGORIES: readonly TriggerCategory[] = [
  "paediatric_high_concern",
  "vitals",
  "bleeding",
  "infection_labs",
];

/**
 * R-09: evaluated only when at least one rule fired; first match wins (order is clinical priority,
 * OQ-39). Bleeding reads CODED fields only, never narrative ("denies blood in stool"). The vitals step
 * reuses the adult fever / SpO2 thresholds with the gynaecology BP and pulse thresholds, as the live
 * formula does.
 */
export function triggerCategory(dept: Department, f: VisitFacts, need: Needs): TriggerCategory {
  if (dept === "paediatrics") return "paediatric_high_concern";

  const bleeding = need.list("category_bleeding_terms");
  if (bleeding && containsAny(`${f.dx} ${f.dx2}`, bleeding)) return "bleeding";

  const fever = need.num("adult_fever_temp_c");
  const spo2Low = need.num("spo2_low_pct");
  const sysLow = need.num("gyn_bp_systolic_low");
  const pulseHigh = need.num("gyn_pulse_high");
  if (
    (fever !== undefined && f.tempC !== null && f.tempC >= fever) ||
    (spo2Low !== undefined && f.spo2 !== null && f.spo2 <= spo2Low) ||
    (sysLow !== undefined && f.bpSystolic !== null && f.bpSystolic < sysLow) ||
    (pulseHigh !== undefined && f.pulse !== null && f.pulse >= pulseHigh)
  )
    return "vitals";

  const infections = need.list("category_infection_terms");
  if (hasInv(f) && infections && containsAny(f.dx, infections)) return "infection_labs";

  if (!isBlank(f.proc)) return "post_procedure";
  return "clinical_check";
}
