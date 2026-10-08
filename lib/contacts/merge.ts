/**
 * Merge preview/resolution. The database function merge_contacts does the
 * transactional work; this decides which scalar values the primary keeps.
 */

export const MERGE_FIELDS = [
  "first_name",
  "last_name",
  "phone_e164",
  "email",
  "gender",
  "nationality",
  "country",
  "language",
  "dob",
  "label",
  "external_id",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  first_name: "First name",
  last_name: "Last name",
  phone_e164: "Phone",
  email: "Email",
  gender: "Gender",
  nationality: "Nationality",
  country: "Country",
  language: "Language",
  dob: "Date of birth",
  label: "Label",
  external_id: "External ID",
};

export type MergeSide = Partial<Record<MergeField, string | null>>;

export type MergeDiff = {
  field: MergeField;
  label: string;
  primary: string | null;
  secondary: string | null;
  /** True when both sides have a value and they differ (needs a decision). */
  conflict: boolean;
};

const blank = (v: string | null | undefined) => v === null || v === undefined || v === "";

export function diffForMerge(primary: MergeSide, secondary: MergeSide): MergeDiff[] {
  return MERGE_FIELDS.map((field) => {
    const p = primary[field] ?? null;
    const s = secondary[field] ?? null;
    return {
      field,
      label: MERGE_FIELD_LABELS[field],
      primary: blank(p) ? null : p,
      secondary: blank(s) ? null : s,
      conflict: !blank(p) && !blank(s) && p !== s,
    };
  });
}

/**
 * Resolves the values to write on the primary. `picks` says which side wins per
 * field ('primary' by default). Blanks on the primary are filled from the
 * secondary; the DB function applies the same fallback.
 */
export function resolveMergeFields(
  primary: MergeSide,
  secondary: MergeSide,
  picks: Partial<Record<MergeField, "primary" | "secondary">> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of diffForMerge(primary, secondary)) {
    const pick = picks[d.field] ?? "primary";
    const chosen = pick === "secondary" ? (d.secondary ?? d.primary) : (d.primary ?? d.secondary);
    if (chosen !== null) out[d.field] = chosen;
  }
  return out;
}
