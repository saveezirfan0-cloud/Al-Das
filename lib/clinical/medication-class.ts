import type { MedClass } from "@/lib/clinical/evaluate";

/**
 * R-05 legacy heuristic, offered as a SUGGESTION on the Unclassified medications screen only.
 *
 * The Make MRD sync classified a drug by substring of the Unite medicine-type text: antibiotic first, then
 * corticosteroid, probiotic, vitamin; blank → unclassified; anything else → other. That is exactly what the
 * clinical rules forbid as a live source (a misclassification sends a probiotic message to someone never on
 * antibiotics), so nothing reads this to classify: a clinician picks the class and the server action records it.
 * Pure, no I/O.
 */
export function suggestMedicationClass(
  medicineType: string | null | undefined,
  allMedicineTypes: ReadonlyArray<string> | null | undefined,
): MedClass {
  const text = [...(allMedicineTypes ?? []), medicineType ?? ""].join(" ").trim().toLowerCase();
  if (!text) return "unclassified";
  if (text.includes("antibiotic")) return "antibiotic";
  if (text.includes("corticosteroid")) return "steroid";
  if (text.includes("probiotic")) return "probiotic";
  if (text.includes("vitamin")) return "supplement";
  return "other";
}

/** The classes a person may choose. "unclassified" is not a choice: it is the fail-closed default. */
export const CHOOSABLE_CLASSES = [
  "antibiotic",
  "steroid",
  "probiotic",
  "supplement",
  "enzyme",
  "other",
] as const satisfies readonly MedClass[];
export type ChoosableClass = (typeof CHOOSABLE_CLASSES)[number];

export const CLASS_LABEL: Record<MedClass, string> = {
  antibiotic: "Antibiotic",
  steroid: "Steroid",
  probiotic: "Probiotic",
  supplement: "Supplement",
  enzyme: "Enzyme",
  other: "Other",
  unclassified: "Unclassified",
};
