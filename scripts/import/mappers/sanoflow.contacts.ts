/**
 * Sanoflow "Contacts → Export" CSV → contact field mapping.
 * Header names seen in exports vary by version, so this extends the generic
 * guesser with Sanoflow-specific aliases and can be overridden with
 * --map=<json> ({ "CSV header": "field_key" | "custom.key" | null }).
 */
import { guessMapping } from "@/lib/contacts/fields";

/** Column holding Sanoflow's own contact id (kept in external_refs for idempotent re-runs). */
export const SANOFLOW_ID_HEADERS = [
  "contact id",
  "contactid",
  "id",
  "contact_id",
  "sanoflow id",
  "sano id",
];

const SANOFLOW_ALIASES: Record<string, string> = {
  "first name": "first_name",
  "last name": "last_name",
  "contact name": "full_name",
  name: "full_name",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  whatsapp: "phone",
  "alternate contacts": "alternate_phones",
  "alternate contact": "alternate_phones",
  "alternate phones": "alternate_phones",
  email: "email",
  gender: "gender",
  nationality: "nationality",
  country: "country",
  language: "language",
  "date of birth": "dob",
  dob: "dob",
  birthday: "dob",
  label: "label",
  "external id": "external_id",
  external_id: "external_id",
  "promotions opt-in": "promotions_opt_in",
  "promotions opt in": "promotions_opt_in",
  "opt in": "promotions_opt_in",
  "stop marketing": "stop_marketing",
  stop_marketing: "stop_marketing",
  tags: "tags",
  source: "source",
  notes: "notes",
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ");

export function sanoflowMapping(
  headers: string[],
  customFields: Array<{ key: string; label: string }> = [],
): Record<string, string | null> {
  const guessed = guessMapping(headers, customFields);
  const used = new Set(Object.values(guessed).filter((v): v is string => !!v));
  for (const h of headers) {
    if (guessed[h]) continue;
    const alias = SANOFLOW_ALIASES[norm(h)];
    if (alias && !used.has(alias)) {
      guessed[h] = alias;
      used.add(alias);
    }
  }
  return guessed;
}

export function findSanoflowIdHeader(headers: string[]): string | null {
  return headers.find((h) => SANOFLOW_ID_HEADERS.includes(norm(h))) ?? null;
}
