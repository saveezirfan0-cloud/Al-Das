import { templateVariables, type TemplateValues } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Turns a Pulse template send (component list + values keyed 'body.1', 'body.2', …) into Sanoflow's `mapper_value` list. Pure.
 *
 * Sanoflow takes one ordered list, which Make fills with the body's {{1}}, {{2}}, … in order. Anything that list cannot
 * express is refused rather than guessed: named parameters, header variables or media, button variables, carousels, and
 * body variables that are not numbered 1..n without gaps. A missing value is refused too (the template would go out with a
 * blank where the patient's name should be).
 */
export type MapperResult = { ok: true; values: string[] } | { ok: false; reason: string };

export function sanoflowMapperValues(
  components: MetaTemplateComponent[],
  values: TemplateValues,
  parameterFormat: "positional" | "named" = "positional",
): MapperResult {
  if (parameterFormat === "named")
    return { ok: false, reason: "Sanoflow sending supports numbered variables ({{1}}) only." };
  if (components.some((c) => c.type === "CAROUSEL"))
    return { ok: false, reason: "Carousel templates cannot be sent through Sanoflow." };
  const vars = templateVariables(components);
  const other = vars.find((v) => v.component !== "body" && !v.optional);
  if (other)
    return {
      ok: false,
      reason: "Sanoflow sending supports body variables only (no header or button variables).",
    };
  const body = vars.filter((v) => v.component === "body");
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const v = body[i]!;
    if (v.index !== i + 1)
      return {
        ok: false,
        reason: "The body variables must be numbered {{1}}, {{2}}, … without gaps.",
      };
    const value = values[v.key];
    if (value === undefined || value.trim() === "")
      return { ok: false, reason: `The value for ${v.key} is missing.` };
    out.push(value);
  }
  return { ok: true, values: out };
}
