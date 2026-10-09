/**
 * custom_fields row → CustomFieldDef. Framework-free (shared by server code and scripts).
 */
import {
  CUSTOM_FIELD_TYPES,
  customFieldOption,
  type CustomFieldDef,
} from "@/lib/contacts/custom-values";
import type { Tables } from "@/lib/supabase/types";

export function toCustomFieldDef(
  row: Pick<Tables<"custom_fields">, "key" | "label" | "type" | "options" | "required">,
): CustomFieldDef {
  const type = (CUSTOM_FIELD_TYPES as readonly string[]).includes(row.type)
    ? (row.type as CustomFieldDef["type"])
    : "text";
  const options = Array.isArray(row.options)
    ? row.options
        .map((o) => customFieldOption.safeParse(o))
        .flatMap((r) => (r.success ? [r.data] : []))
    : [];
  return { key: row.key, label: row.label, type, options, required: row.required };
}
