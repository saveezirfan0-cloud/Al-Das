/**
 * CSV export rows for contacts. Framework-free.
 */
import { formatCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";
import { toCsv } from "@/lib/csv";

export type ExportableContact = {
  id: string;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  alternate_phones?: string[];
  email: string | null;
  gender: string | null;
  nationality: string | null;
  country: string | null;
  language: string | null;
  dob: string | null;
  label: string | null;
  owner_name?: string | null;
  assignee_name?: string | null;
  source: string;
  external_id: string | null;
  promotions_opt_in: boolean;
  stop_marketing: boolean;
  tags?: string[];
  custom: Record<string, unknown> | null;
  last_interaction_at: string | null;
  created_at: string;
};

export const EXPORT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: "id", label: "ID" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "phone_e164", label: "Phone" },
  { key: "alternate_phones", label: "Alternate phones" },
  { key: "email", label: "Email" },
  { key: "gender", label: "Gender" },
  { key: "nationality", label: "Nationality" },
  { key: "country", label: "Country" },
  { key: "language", label: "Language" },
  { key: "dob", label: "Date of birth" },
  { key: "label", label: "Label" },
  { key: "owner_name", label: "Owner" },
  { key: "assignee_name", label: "Assignee" },
  { key: "source", label: "Source" },
  { key: "external_id", label: "External ID" },
  { key: "promotions_opt_in", label: "Promotions opt-in" },
  { key: "stop_marketing", label: "Stop marketing" },
  { key: "tags", label: "Tags" },
  { key: "last_interaction_at", label: "Last interaction" },
  { key: "created_at", label: "Created" },
];

export function contactsToCsv(
  contacts: ExportableContact[],
  customFields: CustomFieldDef[] = [],
): string {
  const headers = [...EXPORT_COLUMNS.map((c) => c.label), ...customFields.map((f) => f.label)];
  const rows = contacts.map((c) => [
    ...EXPORT_COLUMNS.map(({ key }) => {
      const v = (c as unknown as Record<string, unknown>)[key];
      if (typeof v === "boolean") return v ? "yes" : "no";
      if (Array.isArray(v)) return v.join("; ");
      return v ?? "";
    }),
    ...customFields.map((f) => formatCustomValue(f, c.custom?.[f.key])),
  ]);
  return toCsv(headers, rows);
}
