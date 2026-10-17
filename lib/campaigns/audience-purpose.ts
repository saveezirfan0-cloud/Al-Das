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
  get(key: string): { label?: string; clinical?: boolean; careOnly?: boolean } | undefined;
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
    // Unknown counts as clinical; `careOnly` marks health-related fields that stay visible to everyone (appointment
    // doctor, department, service, notes, AI tags) but never build a marketing audience.
    if (!def || def.clinical !== false || def.careOnly === true) out.push(field);
  };
  if (filter) {
    walk(filter.include, check);
    walk(filter.exclude ?? null, check);
  }
  return out;
}

/** Ids of the segments a filter points at (the `segments` field), in first-use order. */
export function segmentIdsIn(filter: Filter | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (node: FilterNode | null | undefined) => {
    if (!node) return;
    if (node.type === "group") {
      for (const c of node.children) visit(c);
      return;
    }
    if (node.field !== "segments") return;
    const v = (node as { value?: unknown }).value;
    for (const id of Array.isArray(v) ? v : [v])
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
  };
  if (filter) {
    visit(filter.include);
    visit(filter.exclude ?? null);
  }
  return out;
}

/** What the server knows about the segment being used, beyond its filter. */
export type SegmentPurposeFacts = {
  /** The segment itself is marked care only (segments.care_only). */
  careOnly?: boolean;
  /** Ids of the segments its filter points at that are care only (checked again at use time, never trusted from save time). */
  careOnlyReferences?: readonly string[];
};

/**
 * A reason the filter may not build an audience for this purpose, or null. Anything but "care" counts as marketing.
 * A segment marked care only (a static list filled from a clinical filter, or a dynamic one that uses a clinical field)
 * is refused for marketing whatever its own filter says, and so is any filter that includes one.
 */
export function audiencePurposeProblem(
  filter: Filter | null | undefined,
  purpose: AudiencePurpose | string | null | undefined,
  registry: PurposeRegistry,
  segment?: SegmentPurposeFacts,
): string | null {
  if (purpose === "care") return null;
  const bad = clinicalFieldsIn(filter, registry);
  if (bad.length === 0) {
    // No health field in the filter itself: the mark is a hand-picked list filled from one, or an included segment.
    return segment?.careOnly || (segment?.careOnlyReferences?.length ?? 0) > 0
      ? "This segment is marked for care programmes only (recall and follow-up), not marketing."
      : null;
  }
  const names = bad
    .slice(0, 3)
    .map((k) => registry.get(k)?.label ?? "an unknown field")
    .join(", ");
  return `This segment uses health information (${names}). Care programmes only (recall and follow-up), not marketing.`;
}
