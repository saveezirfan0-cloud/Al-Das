/**
 * Pure CSV → contact row preparation: mapping, validation (E.164), in-file
 * dedupe and normalisation. The server action / scripts take the prepared rows
 * and write them (matching against existing contacts by phone / external id).
 */
import type { CountryCode } from "libphonenumber-js";

import { coerceCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";
import { normalizeGender, parseBool, splitList } from "@/lib/contacts/fields";
import { parseLooseDate } from "@/lib/contacts/custom-values";
import { normalizePhone } from "@/lib/phone";

export type PreparedContact = {
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  alternate_phones: string[];
  email: string | null;
  gender: "female" | "male" | "other" | "unknown" | null;
  nationality: string | null;
  country: string | null;
  language: string | null;
  dob: string | null;
  label: string | null;
  external_id: string | null;
  promotions_opt_in: boolean | null;
  stop_marketing: boolean | null;
  tags: string[];
  source: string | null;
  note: string | null;
  custom: Record<string, unknown>;
};

export type PreparedRow = {
  /** 1-based line number in the file (excluding the header). */
  line: number;
  status: "ok" | "invalid" | "duplicate";
  errors: string[];
  /** Line of the first row with the same phone / external id (duplicates only). */
  duplicateOf?: number;
  contact: PreparedContact;
};

export type PrepareOptions = {
  /** header → field key ('first_name', 'custom.plan', …) or null to skip. */
  mapping: Record<string, string | null>;
  defaultCountry?: CountryCode;
  customFields?: CustomFieldDef[];
  /** Require a phone on every row (default true). */
  requirePhone?: boolean;
};

export type PrepareSummary = {
  total: number;
  ok: number;
  invalid: number;
  duplicates: number;
};

export function prepareImport(
  headers: string[],
  rows: string[][],
  opts: PrepareOptions,
): { rows: PreparedRow[]; summary: PrepareSummary } {
  const requirePhone = opts.requirePhone ?? true;
  const customDefs = new Map((opts.customFields ?? []).map((d) => [d.key, d]));
  const seenPhone = new Map<string, number>();
  const seenExternal = new Map<string, number>();
  const out: PreparedRow[] = [];

  rows.forEach((cells, idx) => {
    const line = idx + 1;
    const errors: string[] = [];
    const get = (key: string): string => {
      const vals: string[] = [];
      headers.forEach((h, i) => {
        if (opts.mapping[h] === key) vals.push((cells[i] ?? "").trim());
      });
      return vals.filter(Boolean).join(key === "alternate_phones" || key === "tags" ? ";" : " ");
    };

    let first = get("first_name");
    let last = get("last_name");
    const full = get("full_name");
    if (!first && !last && full) {
      const parts = full.split(/\s+/);
      first = parts.shift() ?? "";
      last = parts.join(" ");
    }

    const rawPhone = get("phone");
    let phone: string | null = null;
    if (rawPhone) {
      const norm = normalizePhone(rawPhone, opts.defaultCountry);
      if (norm) phone = norm.e164;
      else errors.push("Invalid phone number");
    } else if (requirePhone) {
      errors.push("Missing phone number");
    }

    const altPhones: string[] = [];
    for (const p of splitList(get("alternate_phones"))) {
      const norm = normalizePhone(p, opts.defaultCountry);
      if (!norm) errors.push(`Invalid alternate phone`);
      else if (norm.e164 !== phone && !altPhones.includes(norm.e164)) altPhones.push(norm.e164);
    }

    const rawEmail = get("email").toLowerCase();
    let email: string | null = null;
    if (rawEmail) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) email = rawEmail;
      else errors.push("Invalid email");
    }

    const rawGender = get("gender");
    const gender = rawGender ? normalizeGender(rawGender) : null;
    if (rawGender && !gender) errors.push("Unknown gender value");

    const rawDob = get("dob");
    let dob: string | null = null;
    if (rawDob) {
      dob = /^\d{4}-\d{2}-\d{2}$/.test(rawDob) ? rawDob : parseLooseDate(rawDob);
      if (!dob) errors.push("Invalid date of birth");
    }

    const rawCountry = get("country").toUpperCase();
    const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
    if (rawCountry && !country) errors.push("Country must be an ISO-2 code");

    const custom: Record<string, unknown> = {};
    for (const [header, target] of Object.entries(opts.mapping)) {
      if (!target?.startsWith("custom.")) continue;
      const def = customDefs.get(target.slice(7));
      if (!def) continue;
      const i = headers.indexOf(header);
      const raw = i >= 0 ? (cells[i] ?? "").trim() : "";
      const res = coerceCustomValue({ ...def, required: false }, raw);
      if (!res.ok) errors.push(res.error);
      else if (res.value !== null) custom[def.key] = res.value;
    }

    const contact: PreparedContact = {
      first_name: first,
      last_name: last,
      phone_e164: phone,
      alternate_phones: altPhones,
      email,
      gender,
      nationality: get("nationality") || null,
      country,
      language: get("language") || null,
      dob,
      label: get("label") || null,
      external_id: get("external_id") || null,
      promotions_opt_in: parseBool(get("promotions_opt_in") || null),
      stop_marketing: parseBool(get("stop_marketing") || null),
      tags: splitList(get("tags")),
      source: get("source") || null,
      note: get("notes") || null,
      custom,
    };

    if (!first && !last && !phone) errors.push("Row is empty");

    let status: PreparedRow["status"] = errors.length ? "invalid" : "ok";
    let duplicateOf: number | undefined;
    if (status === "ok") {
      if (phone && seenPhone.has(phone)) {
        status = "duplicate";
        duplicateOf = seenPhone.get(phone);
      } else if (contact.external_id && seenExternal.has(contact.external_id)) {
        status = "duplicate";
        duplicateOf = seenExternal.get(contact.external_id);
      } else {
        if (phone) seenPhone.set(phone, line);
        if (contact.external_id) seenExternal.set(contact.external_id, line);
      }
    }

    out.push({ line, status, errors, duplicateOf, contact });
  });

  const summary: PrepareSummary = {
    total: out.length,
    ok: out.filter((r) => r.status === "ok").length,
    invalid: out.filter((r) => r.status === "invalid").length,
    duplicates: out.filter((r) => r.status === "duplicate").length,
  };
  return { rows: out, summary };
}
