/**
 * Template variable mapping for campaigns. Each template variable key
 * ("body.1", "header.media", "button.0") maps to a source string:
 *   contact.first_name | contact.last_name | contact.full_name | contact.phone | contact.email
 *   custom.<key>       a contact custom field
 *   csv.<column>       an extra column of the uploaded CSV row
 *   text:<literal>     the same constant for everyone (also media URLs)
 * Pure; unit-tested.
 */
import {
  templateVariables,
  type TemplateValues,
  type TemplateVariable,
} from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export const CONTACT_SOURCES = [
  { key: "contact.first_name", label: "First name" },
  { key: "contact.last_name", label: "Last name" },
  { key: "contact.full_name", label: "Full name" },
  { key: "contact.phone", label: "Phone" },
  { key: "contact.email", label: "Email" },
] as const;

export type VariableContact = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  wa_profile_name?: string | null;
  phone_e164?: string | null;
  email?: string | null;
  custom?: Record<string, unknown> | null;
};

type ContactField = "first_name" | "last_name" | "full_name" | "phone" | "email";

export type ParsedSource =
  | { kind: "contact"; field: ContactField }
  | { kind: "custom"; key: string }
  | { kind: "csv"; column: string }
  | { kind: "text"; value: string };

export function parseSource(source: string | null | undefined): ParsedSource | null {
  if (!source) return null;
  if (source.startsWith("text:")) return { kind: "text", value: source.slice(5) };
  if (source.startsWith("custom.") && source.length > 7)
    return { kind: "custom", key: source.slice(7) };
  if (source.startsWith("csv.") && source.length > 4)
    return { kind: "csv", column: source.slice(4) };
  const m = /^contact\.(first_name|last_name|full_name|phone|email)$/.exec(source);
  if (m) return { kind: "contact", field: m[1] as ContactField };
  return null;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return "";
}

/**
 * Meta rejects template parameters with newlines, tabs or 4+ consecutive spaces
 * (error 132018), and caps them. Normalise before sending.
 */
export function sanitizeParam(value: string, maxLength = 1024): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, maxLength);
}

function rawValue(
  src: ParsedSource,
  contact: VariableContact,
  csv: Record<string, string> | null | undefined,
): string {
  switch (src.kind) {
    case "text":
      return src.value;
    case "csv":
      return csv?.[src.column] ?? "";
    case "custom":
      return scalar(contact.custom?.[src.key]);
    case "contact":
      switch (src.field) {
        case "first_name":
          return (
            contact.first_name?.trim() || contact.wa_profile_name?.trim().split(/\s+/)[0] || ""
          );
        case "last_name":
          return contact.last_name ?? "";
        case "full_name":
          return (
            contact.full_name?.trim() ||
            `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() ||
            contact.wa_profile_name?.trim() ||
            ""
          );
        case "phone":
          return contact.phone_e164 ?? "";
        case "email":
          return contact.email ?? "";
      }
  }
}

export type ResolveInput = {
  components: MetaTemplateComponent[];
  /** Campaign mapping; falls back to the template's own variable_map per key. */
  map: Record<string, string>;
  templateMap?: Record<string, string> | null;
  fallbacks?: Record<string, string> | null;
  contact: VariableContact;
  csv?: Record<string, string> | null;
};

export type ResolveResult = {
  values: TemplateValues;
  /** Variable keys that stayed blank (no mapping, empty value and no fallback). */
  missing: string[];
};

export function resolveVariables(input: ResolveInput): ResolveResult {
  const values: TemplateValues = {};
  const missing: string[] = [];
  for (const v of templateVariables(input.components)) {
    const source = parseSource(input.map[v.key] ?? input.templateMap?.[v.key]);
    let value = source ? sanitizeParam(rawValue(source, input.contact, input.csv)) : "";
    if (!value) value = sanitizeParam(input.fallbacks?.[v.key] ?? "");
    if (value) values[v.key] = value;
    else missing.push(v.key);
  }
  return { values, missing };
}

/** Variables that still have no mapping (so the form can block "Start" before any recipient is touched). */
export function unmappedVariables(
  components: MetaTemplateComponent[],
  map: Record<string, string>,
  templateMap?: Record<string, string> | null,
): TemplateVariable[] {
  return templateVariables(components).filter(
    (v) => !parseSource(map[v.key] ?? templateMap?.[v.key]),
  );
}
