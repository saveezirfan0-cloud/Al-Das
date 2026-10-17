import type { Filter, FilterNode } from "@/lib/filters/ast";

/**
 * The consent rule for segment filters (docs/45 P5). Pure, so the UI, the server and the tests share it.
 *
 * An audience has a purpose:
 *   care       recall and follow-up programmes (the patient is being looked after)
 *   marketing  campaigns
 * A filter that uses a clinical field (visits, doctor, department, chronic condition, diagnosis group, lifecycle ...,
 * see `clinical` in lib/filters/field-registry.ts) is for care only. For a marketing audience it is refused, and
 * anything unknown is refused too (fail closed). Recommendation, still to be signed by the clinical lead and
 * management: care programmes only, unless the patient gave explicit consent to marketing based on clinical data.
 */
export const AUDIENCE_PURPOSES = ["care", "marketing"] as const;
export type AudiencePurpose = (typeof AUDIENCE_PURPOSES)[number];
export const DEFAULT_AUDIENCE_PURPOSE: AudiencePurpose = "marketing";

/** The least a registry must offer: the field's label and whether it is clinical. */
export type PurposeRegistry = {
  get(key: string): { label?: string; clinical?: boolean } | undefined;
};

function walk(node: FilterNode | null | undefined, visit: (field: string) => void) {
  if (!node) return;
  if (node.type === "condition") visit(node.field);
  else for (const c of node.children) walk(c, visit);
}

/** Keys of the clinical (or unknown, which counts as clinical) fields a filter uses, in first-use order. */
export function clinicalFieldsIn(
  filter: Filter | null | undefined,
  registry: PurposeRegistry,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const check = (field: string) => {
    if (seen.has(field)) return;
    seen.add(field);
    const def = registry.get(field);
    if (!def || def.clinical !== false) out.push(field);
  };
  if (filter) {
    walk(filter.include, check);
    walk(filter.exclude ?? null, check);
  }
  return out;
}

/** A reason the filter may not build an audience for this purpose, or null. Anything but "care" counts as marketing. */
export function audiencePurposeProblem(
  filter: Filter | null | undefined,
  purpose: AudiencePurpose | string | null | undefined,
  registry: PurposeRegistry,
): string | null {
  if (purpose === "care") return null;
  const bad = clinicalFieldsIn(filter, registry);
  if (bad.length === 0) return null;
  const names = bad
    .slice(0, 3)
    .map((k) => registry.get(k)?.label ?? "an unknown field")
    .join(", ");
  return `This segment uses health information (${names}). Care programmes only (recall and follow-up), not marketing.`;
}
