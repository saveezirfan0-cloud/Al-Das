import { date, num, str } from "@/lib/finance/scalars";
import {
  MAX_REMITTANCE_ROWS,
  REMITTANCE_FIELDS,
  REMITTANCE_SENSITIVE_HEADERS,
  REMIT_FIELD_NAMES,
  type RemitFieldName,
} from "@/lib/finance/remittance-mapping";
import { readXlsxTable } from "@/lib/finance/parse-diligence";
import { looksLikeRemittanceXml, remittanceXmlToTable } from "@/lib/finance/parse-remittance-xml";
import type { ValidationError } from "@/lib/finance/parse-diligence";

/**
 * Payment advice -> validated, sanitised lines (pure; takes the sheet as an array of rows, header first). Error reports
 * carry row numbers and codes, never cell values. Sensitive and unknown columns are never read.
 */

export type RemitLine = {
  remittance_ref: string;
  paid_on: string | null;
  payer_id: string | null;
  claim_activity_number: string | null;
  invoice_no: string | null;
  cpt_code: string | null;
  quantity: number | null;
  claimed_amount: number | null;
  paid_amount: number;
  denied_amount: number;
  denial_code: string | null;
};

export type RemitHeaderReport = {
  recognised: number;
  missingRequired: string[];
  unrecognised: string[];
  droppedSensitive: string[];
  duplicateHeaders: string[];
};

export type RemitStats = {
  rows: number;
  sumPaid: number;
  sumDenied: number;
  minPaidOn: string | null;
  maxPaidOn: string | null;
  refs: number;
};

export type RemitParseResult =
  | { ok: true; rows: RemitLine[]; header: RemitHeaderReport; stats: RemitStats }
  | { ok: false; errors: ValidationError[]; totalErrors: number; header: RemitHeaderReport };

const MAX_REPORTED_ERRORS = 200;
const squash = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
const SENSITIVE = new Set(REMITTANCE_SENSITIVE_HEADERS.map(squash));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseRemittanceTable(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
): RemitParseResult {
  const headerRow = (table[0] ?? []).map((h) =>
    typeof h === "string" ? h.trim() : h == null ? "" : String(h).trim(),
  );
  const byAlias = new Map<string, RemitFieldName>();
  for (const name of REMIT_FIELD_NAMES)
    for (const alias of REMITTANCE_FIELDS[name].aliases) byAlias.set(squash(alias), name);

  const columnOf = new Map<RemitFieldName, number>();
  const unrecognised: string[] = [];
  const droppedSensitive: string[] = [];
  const duplicateHeaders: string[] = [];
  headerRow.forEach((h, idx) => {
    if (!h) return;
    const k = squash(h);
    if (SENSITIVE.has(k)) return void droppedSensitive.push(h);
    const field = byAlias.get(k);
    if (!field) return void unrecognised.push(h);
    if (columnOf.has(field)) return void duplicateHeaders.push(h);
    columnOf.set(field, idx);
  });

  const missingRequired = REMIT_FIELD_NAMES.filter(
    (n) => REMITTANCE_FIELDS[n].required && !columnOf.has(n),
  );
  const header: RemitHeaderReport = {
    recognised: columnOf.size,
    missingRequired,
    unrecognised,
    droppedSensitive,
    duplicateHeaders,
  };

  const errors: ValidationError[] = [];
  let totalErrors = 0;
  const fail = (e: ValidationError) => {
    totalErrors++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(e);
  };
  if (missingRequired.length > 0) fail({ row: null, code: "missing_required_columns" });
  if (duplicateHeaders.length > 0) fail({ row: null, code: "duplicate_columns" });
  // a line must be identifiable: a claim activity number, or an invoice number with a code
  if (
    !columnOf.has("claim_activity_number") &&
    !(columnOf.has("invoice_no") && columnOf.has("cpt_code"))
  )
    fail({ row: null, code: "no_way_to_identify_claims" });

  const dataRows = table
    .slice(1)
    .filter((r) => r.some((c) => !(c == null || (typeof c === "string" && c.trim() === ""))));
  if (dataRows.length === 0) fail({ row: null, code: "no_data_rows" });
  if (dataRows.length > MAX_REMITTANCE_ROWS) fail({ row: null, code: "too_many_rows" });
  if (totalErrors > 0) return { ok: false, errors, totalErrors, header };

  const rows: RemitLine[] = [];
  dataRows.forEach((raw, i) => {
    const rowNo = i + 2;
    const out: Record<string, string | number | null> = {};
    for (const name of REMIT_FIELD_NAMES) {
      const spec = REMITTANCE_FIELDS[name];
      const col = columnOf.get(name);
      const cell = col === undefined ? null : raw[col];
      const v =
        spec.kind === "number"
          ? num(cell)
          : spec.kind === "date"
            ? date(cell, { allowExcelSerial: true })
            : str(cell);
      if (v === "invalid") {
        fail({ row: rowNo, code: `invalid_${spec.kind}`, field: name });
        out[name] = null;
        continue;
      }
      out[name] = typeof v === "number" ? round2(v) : v;
    }
    if (!out.remittance_ref) fail({ row: rowNo, code: "blank_required", field: "remittance_ref" });
    if (out.paid_amount === null)
      fail({ row: rowNo, code: "blank_required", field: "paid_amount" });
    // A negative paid amount is a payment taken back (recoupment); the matcher flags it `taken_back`.
    if (out.denied_amount !== null && (out.denied_amount as number) < 0)
      fail({ row: rowNo, code: "negative_amount", field: "denied_amount" });
    if (!out.claim_activity_number && !(out.invoice_no && out.cpt_code))
      fail({ row: rowNo, code: "unidentifiable_line" });
    rows.push({
      remittance_ref: (out.remittance_ref as string) ?? "",
      paid_on: out.paid_on as string | null,
      payer_id: out.payer_id as string | null,
      claim_activity_number: out.claim_activity_number as string | null,
      invoice_no: out.invoice_no as string | null,
      cpt_code: out.cpt_code as string | null,
      quantity: out.quantity as number | null,
      claimed_amount: out.claimed_amount as number | null,
      paid_amount: (out.paid_amount as number | null) ?? 0,
      denied_amount: (out.denied_amount as number | null) ?? 0,
      denial_code: out.denial_code as string | null,
    });
  });
  if (totalErrors > 0) return { ok: false, errors, totalErrors, header };

  const dates = rows
    .map((r) => r.paid_on)
    .filter((d): d is string => !!d)
    .sort();
  return {
    ok: true,
    rows,
    header,
    stats: {
      rows: rows.length,
      sumPaid: round2(rows.reduce((a, r) => a + r.paid_amount, 0)),
      sumDenied: round2(rows.reduce((a, r) => a + r.denied_amount, 0)),
      minPaidOn: dates[0] ?? null,
      maxPaidOn: dates.at(-1) ?? null,
      refs: new Set(rows.map((r) => r.remittance_ref)).size,
    },
  };
}

// ---- file readers ----------------------------------------------------------

/** Minimal RFC 4180 reader: quotes, doubled quotes, CRLF, a BOM, and a comma / semicolon / tab delimiter. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Decided by the bytes, never the file name: .xlsx starts with the zip signature "PK", XML with "<", anything else is CSV. */
export function looksLikeXlsx(buffer: Uint8Array): boolean {
  return buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export async function readRemittanceFile(buffer: Buffer): Promise<unknown[][]> {
  if (looksLikeXlsx(buffer))
    return readXlsxTable(buffer, ["Remittance", "RemittanceAdvice", "DataSheet"]);
  if (looksLikeRemittanceXml(buffer)) return remittanceXmlToTable(buffer);
  return parseCsv(buffer.toString("utf8"));
}
