import { ClinicalSettings, Needs } from "@/lib/clinical/settings";
import { txt } from "@/lib/clinical/text";

export type Department = "paediatrics" | "gp" | "gynaecology" | "dermatology" | "other";

/**
 * R-04: Unite supplies a patient-level department string. Substring match from the start of a word
 * (so "Orthopaedics" is not paediatrics), first match wins. Only used as a fallback (R-07).
 */
/** A stem that must start a word ("gyn" matches "gynaecology"; "paed" does not match "orthopaedics"). */
const stem = (t: string) => new RegExp(`(?<![a-z0-9])${t}`, "i");
const PAEDS = [stem("paed"), stem("pedia")];
const GYN = [stem("gyn"), stem("obstet")];
const DERMA = [stem("derma")];
const GP = [stem("general"), stem("internal"), stem("family")];

export function mapDepartment(raw: string | null | undefined): Department {
  const t = txt(raw);
  const any = (res: RegExp[]) => res.some((re) => re.test(t));
  if (any(PAEDS)) return "paediatrics";
  if (any(GYN)) return "gynaecology";
  if (any(DERMA)) return "dermatology";
  if (any(GP)) return "gp";
  return "other";
}

export type EffectiveDepartment = {
  /** null = could not be determined (a needed setting is unsigned): no department rules run. */
  department: Department | null;
  missing: string[];
};

/**
 * R-07 Department Effective. Every trigger reads this, never the raw department.
 *  1. Under the paediatric age cut-off AT THE VISIT → paediatrics, whatever Unite says.
 *  2. Else the doctor's name (trimmed, case-insensitive, exact) in a routing list.
 *  3. Else the mapped department.
 * If the age is known but the cut-off isn't signed off, the answer is "unknown" rather than a guess:
 * a 3-year-old must never be quietly evaluated as a GP patient.
 */
export function departmentEffective(
  input: { ageAtVisit: number | null; doctorName: string | null; mapped: Department | null },
  settings: ClinicalSettings,
): EffectiveDepartment {
  const need = new Needs(settings);
  if (input.ageAtVisit !== null) {
    const cutoff = need.num("paeds_age_cutoff_years");
    if (cutoff === undefined) return { department: null, missing: [...need.missing] };
    if (input.ageAtVisit < cutoff) return { department: "paediatrics", missing: [] };
  }
  const doctor = (input.doctorName ?? "").trim().toLowerCase();
  if (doctor) {
    const routes: Array<[string, Department]> = [
      ["doctor_routing_gynaecology", "gynaecology"],
      ["doctor_routing_paediatrics", "paediatrics"],
      ["doctor_routing_gp", "gp"],
    ];
    for (const [key, dept] of routes) {
      // An unsigned list is empty today (OQ-08): ignoring it can't misroute anyone.
      const list = settings.list(key);
      if (list?.includes(doctor)) return { department: dept, missing: [] };
    }
  }
  return { department: input.mapped, missing: [] };
}
