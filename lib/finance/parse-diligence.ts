import { bool, date, int, num, str } from "@/lib/finance/scalars";
import {
  DILIGENCE_FIELDS,
  DILIGENCE_FIELD_NAMES,
  DILIGENCE_PAYER_NAME_HEADERS,
  DILIGENCE_SENSITIVE_HEADERS,
  type DiligenceFieldName,
} from "@/lib/finance/diligence-mapping";

/**
 * Diligence claims report -> validated, sanitised rows. Pure: it takes the sheet as an array of
 * rows (header first) so it is unit-testable without a spreadsheet; `readXlsxTable` is the thin
 * spreadsheet reader. Error reports carry row numbers and codes, never cell values.
 */

export type ClaimRow = {
  claim_activity_number: string;
  invoice_no: string;
  transaction_date: string | null;
  activity_start_date: string | null;
  encounter_type: string | null;
  cpt_code: string;
  cpt_category: string | null;
  cpt_type: string | null;
  quantity: number | null;
  ordering_clinician_id: string | null;
  clinician_id: string | null;
  receiver_id: string | null;
  payer_id: string | null;
  prior_auth_id: string | null;
  payment_reference: string | null;
  initial_net: number | null;
  net: number | null;
  remitted: number | null;
  last_remitted: number | null;
  initial_rejected: number | null;
  rejected: number | null;
  unprocessed: number | null;
  write_off: number | null;
  write_off_status: string | null;
  settled: boolean | null;
  principal_diagnosis: string | null;
  diagnosis_text: string | null;
  last_denial_code: string | null;
  denial_category: string | null;
  denial_type: string | null;
  denial_comment: string | null;
  initial_denial_code: string | null;
  initial_denial_type: string | null;
  resubmission_count: number | null;
  remittance_count: number | null;
  first_remittance_date: string | null;
  last_remittance_date: string | null;
  last_resubmission_date: string | null;
  claim_status: string | null;
  payment_status: string | null;
  receipt_status: string | null;
  claim_year: number | null;
  claim_month: number | null;
};

export type ValidationError = { row: number | null; code: string; field?: string };

export type HeaderReport = {
  recognised: number;
  /** Logical required fields with no matching column. */
  missingRequired: string[];
  /** Logical optional fields with no matching column (informational). */
  missingOptional: string[];
  /** File headers that match nothing; their data is ignored. */
  unrecognised: string[];
  /** Headers matched to the sensitive list; their data is ignored. */
  droppedSensitive: string[];
  duplicateHeaders: string[];
  /** Insurer display names per payer id (first non-blank seen), used only to fill blank names. */
  payerNames?: PayerName[];
};

export type PayerName = { payer_id: string; payer_name: string };

export type ParseStats = {
  rows: number;
  minTransactionDate: string | null;
  maxTransactionDate: string | null;
  sumNet: number;
  sumRemitted: number;
  sumRejected: number;
};

export type ParseResult =
  | { ok: true; rows: ClaimRow[]; header: HeaderReport; stats: ParseStats }
  | { ok: false; errors: ValidationError[]; totalErrors: number; header: HeaderReport };

export const MAX_ROWS = 30_000; // one atomic commit call carries every changed row
const MAX_REPORTED_ERRORS = 200;

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
const SENSITIVE = new Set(DILIGENCE_SENSITIVE_HEADERS.map(squash));
const PAYER_NAME = new Set(DILIGENCE_PAYER_NAME_HEADERS.map(squash));
const MAX_PAYER_NAMES = 500;
const MAX_PAYER_NAME_LENGTH = 120;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseDiligenceTable(table: ReadonlyArray<ReadonlyArray<unknown>>): ParseResult {
  const headerRow = (table[0] ?? []).map((h) =>
    typeof h === "string" ? h.trim() : h == null ? "" : String(h).trim(),
  );

  // header -> logical field
  const byAlias = new Map<string, DiligenceFieldName>();
  for (const name of DILIGENCE_FIELD_NAMES)
    for (const alias of DILIGENCE_FIELDS[name].aliases) byAlias.set(squash(alias), name);

  const columnOf = new Map<DiligenceFieldName, number>();
  const unrecognised: string[] = [];
  const droppedSensitive: string[] = [];
  const duplicateHeaders: string[] = [];
  let payerNameCol: number | null = null;
  headerRow.forEach((h, idx) => {
    if (!h) return;
    const k = squash(h);
    if (SENSITIVE.has(k)) return void droppedSensitive.push(h);
    if (PAYER_NAME.has(k)) {
      if (payerNameCol === null) payerNameCol = idx;
      return;
    }
    const field = byAlias.get(k);
    if (!field) return void unrecognised.push(h);
    if (columnOf.has(field)) return void duplicateHeaders.push(h);
    columnOf.set(field, idx);
  });

  const missingRequired = DILIGENCE_FIELD_NAMES.filter(
    (n) => DILIGENCE_FIELDS[n].required && !columnOf.has(n),
  );
  const missingOptional = DILIGENCE_FIELD_NAMES.filter(
    (n) => !DILIGENCE_FIELDS[n].required && !columnOf.has(n),
  );
  const header: HeaderReport = {
    recognised: columnOf.size,
    missingRequired,
    missingOptional,
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
  const dataRows = table
    .slice(1)
    .filter((r) => r.some((c) => !(c == null || (typeof c === "string" && c.trim() === ""))));
  if (dataRows.length === 0) fail({ row: null, code: "no_data_rows" });
  if (dataRows.length > MAX_ROWS) fail({ row: null, code: "too_many_rows" });
  if (totalErrors > 0) return { ok: false, errors, totalErrors, header };

  const rows: ClaimRow[] = [];
  const seen = new Map<string, number>();
  const payerNames = new Map<string, string>();
  dataRows.forEach((raw, i) => {
    const rowNo = i + 2; // spreadsheet row number (header is row 1)
    const out: Record<string, string | number | boolean | null> = {};
    for (const name of DILIGENCE_FIELD_NAMES) {
      const spec = DILIGENCE_FIELDS[name];
      const col = columnOf.get(name);
      const cell = col === undefined ? null : raw[col];
      let v: string | number | boolean | null | "invalid";
      switch (spec.kind) {
        case "number":
          v = num(cell);
          break;
        case "int":
          v = int(cell);
          break;
        case "bool":
          v = bool(cell);
          break;
        case "date":
          v = date(cell, { allowExcelSerial: true });
          break;
        default:
          v = str(cell);
      }
      if (v === "invalid") {
        fail({ row: rowNo, code: `invalid_${spec.kind}`, field: name });
        out[name] = null;
        continue;
      }
      if (typeof v === "number" && spec.kind === "number") v = round2(v);
      out[name] = v;
    }
    if (!out.claim_activity_number)
      fail({ row: rowNo, code: "blank_required", field: "claim_activity_number" });
    if (!out.invoice_no) fail({ row: rowNo, code: "blank_required", field: "invoice_no" });
    if (!out.cpt_code) fail({ row: rowNo, code: "blank_required", field: "cpt_code" });
    const month = out.claim_month as number | null;
    if (month !== null && (month < 1 || month > 12))
      fail({ row: rowNo, code: "out_of_range", field: "claim_month" });
    const key = out.claim_activity_number as string | null;
    if (key) {
      if (seen.has(key))
        fail({
          row: rowNo,
          code: "duplicate_claim_activity_number",
          field: "claim_activity_number",
        });
      else seen.set(key, rowNo);
    }
    rows.push(out as unknown as ClaimRow);
    const payerId = out.payer_id as string | null;
    if (payerNameCol !== null && payerId && !payerNames.has(payerId)) {
      const name = payerNameOf(raw[payerNameCol]);
      if (name && payerNames.size < MAX_PAYER_NAMES) payerNames.set(payerId, name);
    }
  });

  if (totalErrors > 0) return { ok: false, errors, totalErrors, header };

  const dates = rows
    .map((r) => r.transaction_date)
    .filter((d): d is string => !!d)
    .sort();
  const sum = (k: "net" | "remitted" | "rejected") =>
    round2(rows.reduce((a, r) => a + (r[k] ?? 0), 0));
  if (payerNameCol !== null)
    header.payerNames = [...payerNames]
      .map(([payer_id, payer_name]) => ({ payer_id, payer_name }))
      .sort((a, b) => a.payer_id.localeCompare(b.payer_id));
  return {
    ok: true,
    rows,
    header,
    stats: {
      rows: rows.length,
      minTransactionDate: dates[0] ?? null,
      maxTransactionDate: dates.at(-1) ?? null,
      sumNet: sum("net"),
      sumRemitted: sum("remitted"),
      sumRejected: sum("rejected"),
    },
  };
}

/** An insurer name cell -> a short single-line name, or null. */
function payerNameOf(cell: unknown): string | null {
  const v = str(cell);
  if (typeof v !== "string") return null;
  const clean = v
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, MAX_PAYER_NAME_LENGTH) : null;
}

// ---- spreadsheet reader ---------------------------------------------------

type CellLike = unknown;

/** ExcelJS cell value -> primitive (rich text, formulas and hyperlinks flattened). */
export function cellToPrimitive(value: CellLike): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("result" in v) return cellToPrimitive(v.result);
    if (Array.isArray(v.richText))
      return v.richText.map((t: { text?: string }) => t.text ?? "").join("");
    if (typeof v.text === "string") return v.text;
    if ("error" in v) return null;
    return null;
  }
  return value;
}

/** Reads the first matching sheet (default "DataSheet", else the first) into a table of primitives. */
export async function readXlsxTable(
  buffer: Buffer | ArrayBuffer | Uint8Array,
  sheetNames: readonly string[] = ["DataSheet"],
): Promise<unknown[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const sheet = sheetNames.map((n) => wb.getWorksheet(n)).find(Boolean) ?? wb.worksheets[0];
  if (!sheet) return [];
  const table: unknown[][] = [];
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellToPrimitive(row.getCell(c).value));
    table.push(cells);
  });
  return table;
}
