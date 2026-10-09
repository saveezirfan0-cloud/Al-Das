/**
 * Catalogue of contact columns used by the grid, the CSV importer (header
 * auto-detection) and the exporter. Framework-free.
 */
import { z } from "zod";

export const GENDERS = ["female", "male", "other", "unknown"] as const;
export const CONTACT_SOURCES = [
  "manual",
  "inbox",
  "import_csv",
  "import_sanoflow",
  "import_airtable",
  "unite",
  "api",
  "flow",
] as const;

export type ImportableField = {
  key: string;
  label: string;
  /** Lower-cased header aliases recognised during CSV import. */
  aliases: string[];
  required?: boolean;
};

export const IMPORTABLE_FIELDS: readonly ImportableField[] = [
  {
    key: "first_name",
    label: "First name",
    aliases: ["first name", "firstname", "first", "given name"],
  },
  {
    key: "last_name",
    label: "Last name",
    aliases: ["last name", "lastname", "last", "surname", "family name"],
  },
  {
    key: "full_name",
    label: "Full name (split on first space)",
    aliases: ["name", "full name", "fullname", "contact name", "patient name", "contact"],
  },
  {
    key: "phone",
    label: "Phone",
    aliases: [
      "phone",
      "phone number",
      "mobile",
      "mobile number",
      "whatsapp",
      "whatsapp number",
      "number",
      "tel",
      "telephone",
      "phone_e164",
    ],
    required: true,
  },
  {
    key: "alternate_phones",
    label: "Alternate phones (; separated)",
    aliases: [
      "alternate phone",
      "alternate phones",
      "alternate contacts",
      "other phone",
      "phone 2",
      "secondary phone",
    ],
  },
  { key: "email", label: "Email", aliases: ["email", "e-mail", "email address"] },
  { key: "gender", label: "Gender", aliases: ["gender", "sex"] },
  { key: "nationality", label: "Nationality", aliases: ["nationality"] },
  { key: "country", label: "Country (ISO-2)", aliases: ["country", "country code"] },
  {
    key: "language",
    label: "Language",
    aliases: ["language", "lang", "preferred language", "language preference"],
  },
  {
    key: "dob",
    label: "Date of birth",
    aliases: ["dob", "date of birth", "birthday", "birth date", "birthdate"],
  },
  { key: "label", label: "Label", aliases: ["label"] },
  {
    key: "external_id",
    label: "External ID (Unite PIN)",
    aliases: [
      "external id",
      "external_id",
      "unite id",
      "unite pin",
      "patient pin",
      "patient id",
      "pin",
      "mrn",
    ],
  },
  {
    key: "promotions_opt_in",
    label: "Promotions opt-in",
    aliases: [
      "promotions opt-in",
      "promotions opt in",
      "opt in",
      "opt-in",
      "marketing opt-in",
      "consent",
      "whatsapp consent",
      "consent for whatsapp",
    ],
  },
  {
    key: "stop_marketing",
    label: "Stop marketing",
    aliases: ["stop marketing", "opted out", "opt out", "unsubscribed", "do not contact"],
  },
  { key: "tags", label: "Tags (; separated)", aliases: ["tags", "tag", "labels"] },
  { key: "source", label: "Source", aliases: ["source", "lead source", "channel"] },
  {
    key: "notes",
    label: "Note (added to timeline)",
    aliases: ["notes", "note", "comment", "comments"],
  },
];

export const IMPORTABLE_KEYS = IMPORTABLE_FIELDS.map((f) => f.key);

const normHeader = (h: string) =>
  h.trim().toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ");

/**
 * Guesses a mapping from CSV headers to contact fields. Custom field keys are
 * matched by their label or key as `custom.<key>`. Unmatched headers map to null.
 */
export function guessMapping(
  headers: string[],
  customFields: Array<{ key: string; label: string }> = [],
): Record<string, string | null> {
  const used = new Set<string>();
  const mapping: Record<string, string | null> = {};
  for (const h of headers) {
    const n = normHeader(h);
    let target: string | null = null;
    for (const f of IMPORTABLE_FIELDS) {
      if (used.has(f.key)) continue;
      if (f.aliases.includes(n) || normHeader(f.label) === n) {
        target = f.key;
        break;
      }
    }
    if (!target) {
      const cf = customFields.find(
        (c) => normHeader(c.label) === n || c.key === n.replace(/ /g, "_"),
      );
      if (cf && !used.has(`custom.${cf.key}`)) target = `custom.${cf.key}`;
    }
    if (target) used.add(target);
    mapping[h] = target;
  }
  return mapping;
}

export function normalizeGender(raw: string | null | undefined): (typeof GENDERS)[number] | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (["f", "female", "woman", "w"].includes(s)) return "female";
  if (["m", "male", "man"].includes(s)) return "male";
  if (["o", "other", "non-binary", "nonbinary", "x"].includes(s)) return "other";
  if (["u", "unknown", "n/a", "na", "-"].includes(s)) return "unknown";
  return null;
}

export function parseBool(raw: string | boolean | null | undefined): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "on", "checked", "opted in", "opt-in", "opt in"].includes(s))
    return true;
  if (["false", "no", "n", "0", "off", "unchecked", "opted out", "opt-out", "opt out"].includes(s))
    return false;
  return null;
}

export function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[;|,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Shared Zod schema for creating/updating a contact from forms and actions. */
export const contactInputSchema = z.object({
  first_name: z.string().trim().max(80).default(""),
  last_name: z.string().trim().max(80).default(""),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  nationality: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  language: z.string().trim().max(40).nullable().optional(),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  label: z.string().trim().max(80).nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  source: z.enum(CONTACT_SOURCES).optional(),
  external_id: z.string().trim().max(80).nullable().optional(),
  promotions_opt_in: z.boolean().optional(),
  stop_marketing: z.boolean().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type ContactInput = z.input<typeof contactInputSchema>;

/** Columns shown in the grid by default, in order. */
export const DEFAULT_GRID_COLUMNS = [
  "full_name",
  "phone",
  "gender",
  "nationality",
  "tags",
  "last_interaction_at",
  "created_at",
] as const;
