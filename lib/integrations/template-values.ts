import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Fills a WhatsApp template from a CLOSED set of named values (pure). Used by integrations that send one fixed kind of message
 * (review requests): the settings page maps each template variable to one of the sources, and nothing else can reach a template.
 *
 * Only text variables in the header or body are supported; a media header or a button variable is reported in `unsupported`.
 * A variable with no mapping is in `missing`, and the caller must not send.
 */
export type MappedValues<S extends string> = {
  values: Record<string, string>;
  missing: string[];
  unsupported: string[];
  used: Set<S>;
};

export function mapTemplateValues<S extends string>(
  components: MetaTemplateComponent[],
  variableMap: Record<string, string> | null | undefined,
  ctx: Record<S, string>,
  sources: readonly S[],
): MappedValues<S> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const unsupported: string[] = [];
  const used = new Set<S>();
  for (const v of templateVariables(components)) {
    if (v.kind !== "text" || v.component === "button") {
      unsupported.push(v.key);
      continue;
    }
    const source = variableMap?.[v.key];
    if (source && (sources as readonly string[]).includes(source)) {
      const key = source as S;
      values[v.key] = ctx[key];
      used.add(key);
    } else missing.push(v.key);
  }
  return { values, missing, unsupported, used };
}
