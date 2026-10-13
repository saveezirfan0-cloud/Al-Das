import { mapTemplateValues } from "@/lib/integrations/template-values";
import { REVIEW_VALUE_SOURCES, type ReviewValueSource } from "@/lib/integrations/reviews/config";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ReviewValueContext = Record<ReviewValueSource, string>;

const SOURCE_KEYS = REVIEW_VALUE_SOURCES.map((s) => s.key);

export function reviewValues(
  components: MetaTemplateComponent[],
  variableMap: Record<string, string> | null | undefined,
  ctx: ReviewValueContext,
) {
  const r = mapTemplateValues<ReviewValueSource>(components, variableMap, ctx, SOURCE_KEYS);
  return {
    values: r.values,
    missing: r.missing,
    unsupported: r.unsupported,
    hasLink: r.used.has("review_link"),
  };
}

/** A context for checking a template mapping without any real data. */
export const REVIEW_PROBE_CONTEXT: ReviewValueContext = {
  first_name: "x",
  patient_first_name: "x",
  clinic_name: "x",
  review_link: "x",
};

/** First word of a name, for greetings. A patient's surname never goes into a review request. */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}
