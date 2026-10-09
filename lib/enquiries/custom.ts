import { coerceCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";

/**
 * Coerces submitted custom values against the org's enquiry field definitions and
 * merges them over the existing values. Unknown keys are dropped; a null value
 * removes the key. Returns the first error so the form can show it.
 */
export function mergeEnquiryCustom(
  defs: readonly CustomFieldDef[],
  existing: Record<string, unknown>,
  submitted: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const next: Record<string, unknown> = { ...existing };
  for (const def of defs) {
    if (!(def.key in submitted)) continue;
    const res = coerceCustomValue(def, submitted[def.key]);
    if (!res.ok) return { ok: false, error: res.error };
    if (res.value === null) delete next[def.key];
    else next[def.key] = res.value;
  }
  for (const k of Object.keys(next)) if (!defs.some((d) => d.key === k)) delete next[k];
  return { ok: true, value: next };
}
