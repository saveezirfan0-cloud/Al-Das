import type { PreparedContact } from "@/lib/contacts/import";

/** One Airtable record mapped to a contact. */
export type MappedPatient = {
  /** Airtable record id (external_refs key). */
  recordId: string;
  contact: PreparedContact;
  /** Other systems' ids found on the record, e.g. { sanoflow: '123' }. */
  refs: Record<string, string>;
  /** Non-PHI send-state flags kept on external_refs.meta for the recall engine (Phase 8). */
  meta: Record<string, string | number | boolean | null>;
  /** Field-level problems (the row is still imported when a phone or PIN exists). */
  warnings: string[];
  isTestRecord: boolean;
};

export type PatientMapper = {
  baseId: string;
  tableId: string;
  /** Human name for reports. */
  name: string;
  /** Field IDs the mapper reads (coverage report lists the rest as unmapped). */
  fieldIds: readonly string[];
  /** Custom fields the mapper writes into; created when missing. */
  customFields: Array<{
    key: string;
    label: string;
    type: "text" | "date" | "boolean" | "select";
    options?: Array<{ value: string; label: string }>;
  }>;
  map(record: { id: string; fields: Record<string, unknown> }): MappedPatient;
};

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object" && v && "name" in v) return String((v as { name: unknown }).name ?? "");
  return String(v).trim();
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function emptyContact(): PreparedContact {
  return {
    first_name: "",
    last_name: "",
    phone_e164: null,
    alternate_phones: [],
    email: null,
    gender: null,
    nationality: null,
    country: null,
    language: null,
    dob: null,
    label: null,
    external_id: null,
    promotions_opt_in: null,
    stop_marketing: null,
    tags: [],
    source: "import_airtable",
    note: null,
    custom: {},
  };
}
