/**
 * Audience rules: who may receive a campaign, and CSV audience parsing.
 * Fail closed: anything unknown or blank is skipped, never sent.
 */
import type { CountryCode } from "libphonenumber-js";

import { MAX_RECIPIENTS } from "@/lib/campaigns/constants";
import { csvToObjects, parseCsv } from "@/lib/csv";
import { DEFAULT_COUNTRY, normalizePhone } from "@/lib/phone";

export type RecipientContact = {
  deleted_at?: string | null;
  phone_e164?: string | null;
  wa_bsuid?: string | null;
  promotions_opt_in?: boolean | null;
  stop_marketing?: boolean | null;
};

export type SkipReason =
  "deleted" | "not_found" | "no_destination" | "stop_marketing" | "no_opt_in";

/**
 * null = eligible. MARKETING templates need an explicit opt-in and no stop_marketing;
 * other categories only need a way to reach the contact. Checked at snapshot time and
 * again right before dispatch (131050 can arrive mid-campaign).
 */
export function classifyRecipient(
  contact: RecipientContact | null | undefined,
  opts: { marketing: boolean },
): SkipReason | null {
  if (!contact) return "not_found";
  if (contact.deleted_at) return "deleted";
  if (!contact.phone_e164 && !contact.wa_bsuid) return "no_destination";
  if (opts.marketing) {
    if (contact.stop_marketing) return "stop_marketing";
    if (contact.promotions_opt_in !== true) return "no_opt_in";
  }
  return null;
}

export function isMarketingCategory(category: string | null | undefined): boolean {
  return (category ?? "").toUpperCase() === "MARKETING";
}

// ---------------------------------------------------------------------------
// CSV audience
// ---------------------------------------------------------------------------

export type CsvAudienceRow = {
  phone_e164: string;
  first_name: string;
  last_name: string;
  /** Remaining columns, usable as csv.<column> variables. */
  data: Record<string, string>;
};

export type CsvAudience = {
  rows: CsvAudienceRow[];
  /** Columns available as csv.<column> variables. */
  columns: string[];
  rejected: Array<{ line: number; reason: string }>;
  duplicates: number;
  tooMany: boolean;
};

const PHONE_HEADER =
  /^(phone|phone[ _-]?number|mobile|mobile[ _-]?number|whatsapp|whatsapp[ _-]?number|number|msisdn|tel|telephone)$/i;
const FIRST_HEADER = /^(first[ _-]?name|firstname|given[ _-]?name)$/i;
const LAST_HEADER = /^(last[ _-]?name|lastname|surname|family[ _-]?name)$/i;
const NAME_HEADER = /^(name|full[ _-]?name|patient[ _-]?name)$/i;

const MAX_EXTRA_COLUMNS = 10;
const MAX_CELL = 200;

function columnKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseCsvAudience(
  text: string,
  opts: { defaultCountry?: CountryCode; maxRows?: number } = {},
): CsvAudience | { error: string } {
  const csv = parseCsv(text);
  if (csv.headers.length === 0) return { error: "The file is empty." };
  const phoneHeader = csv.headers.find((h) => PHONE_HEADER.test(h.trim()));
  if (!phoneHeader)
    return { error: 'No phone column found. Name it "phone", "mobile" or "whatsapp".' };
  const firstHeader = csv.headers.find((h) => FIRST_HEADER.test(h.trim()));
  const lastHeader = csv.headers.find((h) => LAST_HEADER.test(h.trim()));
  const nameHeader = csv.headers.find((h) => NAME_HEADER.test(h.trim()));
  const used = new Set([phoneHeader, firstHeader, lastHeader, nameHeader].filter(Boolean));

  const extra = csv.headers
    .filter((h) => !used.has(h) && columnKey(h))
    .slice(0, MAX_EXTRA_COLUMNS)
    .map((h) => ({ header: h, key: columnKey(h) }));
  // first_name / last_name stay available as csv.* variables too.
  const columns = [
    ...(firstHeader ? ["first_name"] : []),
    ...(lastHeader ? ["last_name"] : []),
    ...(nameHeader ? ["name"] : []),
    ...extra.map((e) => e.key),
  ];

  const maxRows = opts.maxRows ?? MAX_RECIPIENTS;
  const objects = csvToObjects(csv);
  const result: CsvAudience = { rows: [], columns, rejected: [], duplicates: 0, tooMany: false };
  const seen = new Set<string>();

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const line = i + 2; // header is line 1
    const rawPhone = (o[phoneHeader] ?? "").trim();
    if (!rawPhone && Object.values(o).every((v) => !v.trim())) continue; // blank line
    const phone = normalizePhone(rawPhone, opts.defaultCountry ?? DEFAULT_COUNTRY);
    if (!phone) {
      result.rejected.push({
        line,
        reason: rawPhone ? "Not a valid phone number" : "Missing phone",
      });
      continue;
    }
    if (seen.has(phone.e164)) {
      result.duplicates++;
      continue;
    }
    if (result.rows.length >= maxRows) {
      result.tooMany = true;
      break;
    }
    seen.add(phone.e164);

    let first = (firstHeader ? o[firstHeader] : "")?.trim() ?? "";
    let last = (lastHeader ? o[lastHeader] : "")?.trim() ?? "";
    const full = (nameHeader ? o[nameHeader] : "")?.trim() ?? "";
    if (!first && !last && full) {
      const [head, ...rest] = full.split(/\s+/);
      first = head ?? "";
      last = rest.join(" ");
    }
    const data: Record<string, string> = {};
    if (firstHeader) data.first_name = first.slice(0, MAX_CELL);
    if (lastHeader) data.last_name = last.slice(0, MAX_CELL);
    if (nameHeader) data.name = full.slice(0, MAX_CELL);
    for (const e of extra) data[e.key] = (o[e.header] ?? "").trim().slice(0, MAX_CELL);
    result.rows.push({
      phone_e164: phone.e164,
      first_name: first.slice(0, MAX_CELL),
      last_name: last.slice(0, MAX_CELL),
      data,
    });
  }
  return result;
}
