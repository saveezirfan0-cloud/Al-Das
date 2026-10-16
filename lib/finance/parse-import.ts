import {
  fieldsFor,
  headerKey,
  type DateFormat,
  type ImportFormat,
} from "@/lib/finance/import-kinds";
import { readXlsxTable } from "@/lib/finance/parse-diligence";
import { looksLikeXlsx, parseCsv } from "@/lib/finance/parse-remittance";
import { blank, num, str } from "@/lib/finance/scalars";
import { redactStatementText } from "@/lib/redact";

/**
 * Bank statements and processor settlement reports -> sanitised rows (pure, apart from reading the file). The layout
 * (fin_import_formats) names the header of each mapped column; ONLY those columns are read, every other column is
 * ignored. A mapped header that is missing refuses the whole file and lists what is missing. Error messages carry row
 * numbers and field names, never cell values. Texts pass through redactStatementText before they are returned.
 */

export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const HEADER_SCAN_ROWS = 30; // statements often start with a few lines about the account
const MAX_REPORTED_ERRORS = 10;

export type BankRow = {
  value_date: string;
  amount: number;
  reference: string | null;
  description: string | null;
};

export type SettlementRow = {
  txn_date: string;
  settlement_date: string;
  gross: number;
  fee: number;
  net: number;
  reference: string | null;
};

export type ImportStats = {
  rows: number;
  skipped: number;
  credits: number;
  debits: number;
  firstDate: string | null;
  lastDate: string | null;
};

export type ImportResult<T> =
  { ok: true; rows: T[]; stats: ImportStats } | { ok: false; missing: string[]; errors: string[] };

/** .xlsx (first sheet) or CSV text. */
export async function readImportFile(buffer: Buffer): Promise<unknown[][]> {
  if (looksLikeXlsx(buffer)) return readXlsxTable(buffer, []);
  return parseCsv(buffer.toString("utf8"));
}

const pad = (n: number) => String(n).padStart(2, "0");
function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A date in the layout's format (separators / - . and a trailing time are accepted), an Excel date cell, or an Excel
 * serial number from an .xlsx. Two-digit years are refused (never guessed). null = blank, "invalid" = unreadable.
 */
export function readDate(v: unknown, format: DateFormat): string | null | "invalid" {
  if (blank(v)) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "invalid";
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) ?? "invalid";
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 20_000 || v > 80_000) return "invalid";
    const dt = new Date(Math.round((v - 25_569) * 86_400_000)); // 25569 = 1899-12-30 to 1970-01-01
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) ?? "invalid";
  }
  if (typeof v !== "string") return "invalid";
  const s = v.trim();
  const m =
    format === "YYYY-MM-DD"
      ? /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s)
      : /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(s);
  if (!m) return "invalid";
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const out =
    format === "YYYY-MM-DD" ? ymd(a, b, c) : format === "DD/MM/YYYY" ? ymd(c, b, a) : ymd(c, a, b);
  return out ?? "invalid";
}

/** An amount: 1234.5, "1,234.50", "-12", "AED 1,234.50", "(12.00)" (negative). null = blank. */
export function readAmount(v: unknown): number | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v === "string") {
    let s = v
      .trim()
      .replace(/^AED\s*/i, "")
      .replace(/\s*AED$/i, "");
    let negative = false;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) {
      negative = true;
      s = paren[1].trim();
    }
    const n = num(s);
    if (n === null || n === "invalid") return n === null ? null : "invalid";
    return Math.round((negative ? -n : n) * 100) / 100;
  }
  const n = num(v);
  return n === null || n === "invalid" ? n : Math.round(n * 100) / 100;
}

const cellText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
};

/**
 * Finds the header row: the first of the first rows holding every mapped header. Without one, reports the headers
 * missing from the closest row. A mapped header that appears twice in the header row is refused (which one to read
 * would be a guess).
 */
function locateColumns(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  mapping: Record<string, string>,
  labels: Record<string, string>,
):
  | { ok: true; headerRow: number; columns: Record<string, number> }
  | { ok: false; missing: string[]; errors: string[] } {
  const wanted = Object.entries(mapping).map(([field, header]) => ({
    field,
    key: headerKey(header),
    header,
  }));
  let best = { row: -1, found: -1 };
  for (let r = 0; r < Math.min(table.length, HEADER_SCAN_ROWS); r++) {
    const keys = (table[r] ?? []).map((c) => headerKey(cellText(c)));
    const found = wanted.filter((w) => keys.includes(w.key)).length;
    if (found > best.found) best = { row: r, found };
    if (found === wanted.length) {
      const columns: Record<string, number> = {};
      for (const w of wanted) {
        const idx = keys.indexOf(w.key);
        if (keys.indexOf(w.key, idx + 1) !== -1)
          return {
            ok: false,
            missing: [],
            errors: [`The column "${w.header}" appears twice in the header row.`],
          };
        columns[w.field] = idx;
      }
      return { ok: true, headerRow: r, columns };
    }
  }
  const keys = best.row >= 0 ? (table[best.row] ?? []).map((c) => headerKey(cellText(c))) : [];
  const missing = wanted
    .filter((w) => !keys.includes(w.key))
    .map((w) => `${w.header} (${labels[w.field] ?? w.field})`);
  return {
    ok: false,
    missing,
    errors: [`The file is missing ${missing.length} mapped column(s).`],
  };
}

type Cells = Record<string, unknown>;

function parseWith<T>(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  format: ImportFormat,
  build: (cells: Cells, rowNo: number, fail: (msg: string) => void) => T | "skip" | null,
  dateOf: (row: T) => string,
  amountOf: (row: T) => number,
): ImportResult<T> {
  const fields = fieldsFor(format.kind, format.amountStyle);
  const labels = Object.fromEntries(fields.map((f) => [f.key, f.spec.label]));
  const missingRequired = fields.filter((f) => f.required && !format.mapping[f.key]);
  if (missingRequired.length > 0)
    return {
      ok: false,
      missing: [],
      errors: [
        `The layout does not map: ${missingRequired.map((f) => f.spec.label).join(", ")}. Fix the layout first.`,
      ],
    };
  // only the fields of this kind and style are ever read
  const mapping = Object.fromEntries(
    fields.filter((f) => format.mapping[f.key]).map((f) => [f.key, format.mapping[f.key]]),
  );
  const located = locateColumns(table, mapping, labels);
  if (!located.ok) return located;

  const errors: string[] = [];
  let total = 0;
  const fail = (msg: string) => {
    total++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(msg);
  };
  const rows: T[] = [];
  let skipped = 0;
  const body = table.slice(located.headerRow + 1);
  if (body.length > MAX_IMPORT_ROWS)
    return {
      ok: false,
      missing: [],
      errors: [`The file has more than ${MAX_IMPORT_ROWS} rows. Split it.`],
    };
  body.forEach((raw, i) => {
    const rowNo = located.headerRow + i + 2; // 1-based, as a spreadsheet shows it
    const cells: Cells = {};
    for (const [field, idx] of Object.entries(located.columns)) cells[field] = raw[idx];
    if (Object.values(cells).every(blank)) return void skipped++;
    const row = build(cells, rowNo, fail);
    if (row === "skip") skipped++;
    else if (row) rows.push(row);
  });
  if (total > 0) {
    if (total > errors.length) errors.push(`... and ${total - errors.length} more.`);
    return { ok: false, missing: [], errors };
  }
  if (rows.length === 0) return { ok: false, missing: [], errors: ["The file has no data rows."] };
  const dates = rows.map(dateOf).sort();
  const cents = rows.map((r) => Math.round(amountOf(r) * 100));
  return {
    ok: true,
    rows,
    stats: {
      rows: rows.length,
      skipped,
      credits: cents.filter((c) => c > 0).reduce((a, c) => a + c, 0) / 100,
      debits: cents.filter((c) => c < 0).reduce((a, c) => a - c, 0) / 100,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
    },
  };
}

const label = (format: ImportFormat, field: string): string =>
  fieldsFor(format.kind, format.amountStyle).find((f) => f.key === field)?.spec.label ?? field;

/** Records a row problem and drops the row. */
function bad(fail: (msg: string) => void, msg: string): null {
  fail(msg);
  return null;
}

/**
 * Bank statement rows. Signed style: one amount column (money in > 0). Debit / credit style: amount = credit - debit.
 * A row with neither a date nor an amount (a balance or continuation line) is skipped; a row with only one of the two
 * refuses the file; a zero amount is skipped.
 */
export function parseBankStatement(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  format: ImportFormat,
): ImportResult<BankRow> {
  if (format.kind !== "bank_statement")
    return { ok: false, missing: [], errors: ["This layout is not for bank statements."] };
  return parseWith<BankRow>(
    table,
    format,
    (cells, rowNo, fail) => {
      const date = readDate(cells.value_date, format.dateFormat);
      let amount: number | null;
      if (format.amountStyle === "signed") {
        const a = readAmount(cells.amount);
        if (a === "invalid")
          return bad(fail, `Row ${rowNo}: ${label(format, "amount")} is not a number.`);
        amount = a;
      } else {
        const cr = readAmount(cells.credit);
        const dr = readAmount(cells.debit);
        if (cr === "invalid" || dr === "invalid")
          return bad(fail, `Row ${rowNo}: the debit or credit is not a number.`);
        if (cr && dr) return bad(fail, `Row ${rowNo}: both a debit and a credit.`);
        amount = cr === null && dr === null ? null : Math.abs(cr ?? 0) - Math.abs(dr ?? 0);
      }
      if (date === null && amount === null) return "skip";
      if (date === "invalid")
        return bad(fail, `Row ${rowNo}: the value date is not a date in ${format.dateFormat}.`);
      if (date === null) return bad(fail, `Row ${rowNo}: an amount without a value date.`);
      if (amount === null) return bad(fail, `Row ${rowNo}: a value date without an amount.`);
      if (amount === 0) return "skip";
      return {
        value_date: date,
        amount: Math.round(amount * 100) / 100,
        reference: redactStatementText(str(cells.reference), 80),
        description: redactStatementText(str(cells.description), 200),
      };
    },
    (r) => r.value_date,
    (r) => r.amount,
  );
}

/** Processor settlement rows: both dates, gross and net are required; fee defaults to gross - net. */
export function parseSettlement(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  format: ImportFormat,
): ImportResult<SettlementRow> {
  if (format.kind !== "settlement")
    return { ok: false, missing: [], errors: ["This layout is not for settlement reports."] };
  return parseWith<SettlementRow>(
    table,
    format,
    (cells, rowNo, fail) => {
      const txn = readDate(cells.transaction_date, format.dateFormat);
      const settled = readDate(cells.settlement_date, format.dateFormat);
      const gross = readAmount(cells.gross);
      const net = readAmount(cells.net);
      const fee = readAmount(cells.fee);
      if (txn === null && gross === null && net === null) return "skip";
      if (txn === "invalid" || txn === null || settled === "invalid" || settled === null)
        return bad(fail, `Row ${rowNo}: both dates are needed, in ${format.dateFormat}.`);
      if (
        gross === "invalid" ||
        gross === null ||
        net === "invalid" ||
        net === null ||
        fee === "invalid"
      )
        return bad(fail, `Row ${rowNo}: gross and net must be numbers (and the fee, when given).`);
      return {
        txn_date: txn,
        settlement_date: settled,
        gross,
        net,
        fee: fee === null ? Math.round((gross - net) * 100) / 100 : Math.abs(fee),
        reference: redactStatementText(str(cells.reference), 80),
      };
    },
    (r) => r.txn_date,
    (r) => r.net,
  );
}

/** A lab or provider file row, sanitised: codes, dates, an amount, the Unite PIN and a doctor id. Nothing else. */
export type ProviderRow = {
  service_date: string;
  code: string;
  patient_pin: string | null;
  doctor_dha_id: string | null;
  branch: string | null; // as written in the file; the server resolves it to a branch code before storing
  result_date: string | null;
  amount: number | null;
  invoice_no: string | null;
};

/** A CPT or Unite item code; a lab may join components with "+" ("87177+87209"), kept as one code, never split. */
const CODE_RE = /^[A-Z0-9][A-Z0-9._/+-]{0,59}$/;
/** A Unite PIN or a DHA id: letters, digits, "/" and "-", at least one digit. A name never passes (spaces, no digit). */
const ID_RE = /^[A-Z0-9][A-Z0-9/-]{0,39}$/;
const INVOICE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,39}$/; // ":" for voucher numbers like "Req:19998"
export const isPinLike = (v: string) => ID_RE.test(v) && /\d/.test(v);
export const isTestCode = (v: string) => CODE_RE.test(v);

/**
 * Lab activity reports and provider invoices (send-out lab, hospital, radiology). ONLY the mapped columns of the kind's
 * field list are read, and that list has no name or ID-number field. Each text value must look like what it is (a code,
 * a PIN, a DHA id, an invoice number): a cell that does not refuses the file, so a wrongly mapped name column can never
 * be stored. Errors carry row numbers and field names, never cell values.
 */
export function parseProviderLines(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  format: ImportFormat,
): ImportResult<ProviderRow> {
  if (format.kind !== "lab_activity" && format.kind !== "provider_invoice")
    return { ok: false, missing: [], errors: ["This layout is not for lab or provider files."] };
  const invoice = format.kind === "provider_invoice";
  return parseWith<ProviderRow>(
    table,
    format,
    (cells, rowNo, fail) => {
      const service = readDate(cells.service_date, format.dateFormat);
      const rawCode = str(cells.test_code);
      const amount = invoice ? readAmount(cells.amount) : null;
      if (service === null && rawCode === null) return "skip"; // a total or sub-total line
      if (service === "invalid" || service === null)
        return bad(
          fail,
          `Row ${rowNo}: the service date is missing or not in ${format.dateFormat}.`,
        );
      const code = rawCode?.toUpperCase() ?? null;
      if (!code || !CODE_RE.test(code))
        return bad(fail, `Row ${rowNo}: ${label(format, "test_code")} is missing or not a code.`);
      const pin = str(cells.patient_pin)?.toUpperCase() ?? null;
      if (pin !== null && !isPinLike(pin))
        return bad(
          fail,
          `Row ${rowNo}: ${label(format, "patient_pin")} does not look like a Unite PIN.`,
        );
      const doctor = str(cells.doctor_dha_id)?.toUpperCase() ?? null;
      if (doctor !== null && !isPinLike(doctor))
        return bad(
          fail,
          `Row ${rowNo}: ${label(format, "doctor_dha_id")} does not look like a DHA id.`,
        );
      const branch = str(cells.branch);
      if (branch !== null && branch.length > 40)
        return bad(fail, `Row ${rowNo}: ${label(format, "branch")} is too long.`);
      const result = readDate(cells.result_date, format.dateFormat);
      if (result === "invalid")
        return bad(fail, `Row ${rowNo}: the result date is not in ${format.dateFormat}.`);
      if (result !== null && result < service)
        return bad(fail, `Row ${rowNo}: the result date is before the service date.`);
      if (amount === "invalid") return bad(fail, `Row ${rowNo}: the amount is not a number.`);
      if (invoice && amount === null) return bad(fail, `Row ${rowNo}: the amount is missing.`);
      if (amount !== null && amount < 0)
        return bad(fail, `Row ${rowNo}: a negative amount (credit lines are not accepted).`);
      const invoiceNo = invoice ? str(cells.invoice_number) : null;
      if (invoiceNo !== null && !INVOICE_RE.test(invoiceNo))
        return bad(
          fail,
          `Row ${rowNo}: ${label(format, "invoice_number")} is not an invoice number.`,
        );
      return {
        service_date: service,
        code,
        patient_pin: pin,
        doctor_dha_id: doctor,
        branch,
        result_date: result,
        amount,
        invoice_no: invoiceNo,
      };
    },
    (r) => r.service_date,
    (r) => r.amount ?? 0,
  );
}
