import { cellToPrimitive } from "@/lib/finance/parse-diligence";
import {
  amountMils,
  CATEGORY_END_BEFORE,
  CATEGORY_START_AFTER,
  cleanText,
  doctorDisplayName,
  DUBAI_OFFSET_MS,
  idText,
  MAX_REPORT_ROWS,
  MAX_SUMMARY_ROWS,
  NO_DOCTOR_KEY,
  NO_DOCTOR_NAME,
  normaliseDoctorKey,
  PAYMENT_SECTION_END,
  RAW_AMOUNT_COLUMNS,
  RAW_NEVER_READ_HEADERS,
  RAW_REQUIRED_HEADERS,
  RAW_SHEET,
  RAW_TEXT_COLUMNS,
  RECONCILED_TOTAL_KEYS,
  RECONCILED_TOTALS,
  recordCancelled,
  REPORT_AMOUNT_FIELDS,
  SERIAL_HEADER,
  SUMMARY_HEADER_MARKERS,
  SUMMARY_SHEET,
  SUMMARY_TOTAL_LABEL,
  TITLE_PATTERN,
  TITLE_SEARCH_ROWS,
  titleDate,
  visitStatus,
  type ReconciledTotal,
  type ReportAmountField,
  type VisitStatus,
} from "@/lib/finance/unite-report-mapping";

/**
 * Unite "Daily Collection Multi-Clinic Report" (.xlsx) -> sanitised visit rows, the report's own totals and the
 * reconciliation (Phase 23A). Pure apart from the spreadsheet read; column names come only from unite-report-mapping.ts.
 * Anything unexpected fails closed with a UniteReportError whose message is a fixed sentence with column names, row
 * numbers and counts, never cell content.
 */

/** One RawData row; fields map 1:1 to fin_report_visits columns. Amounts in AED (2 dp). */
export type UniteReportRow = {
  row_no: number;
  visit_at: string | null;
  invoice_date: string | null;
  report_date: string;
  department: string | null;
  doctor_name: string;
  doctor_key: string;
  clinic_name: string | null;
  patient_pin: string | null;
  visit_status: VisitStatus | null;
  invoice_type: string | null;
  selfpay_invoice_no: string | null;
  insurance_invoice_no: string | null;
  categories: Record<string, number>;
  is_cancelled: boolean;
} & Record<ReportAmountField, number>;

export type ReportTotals = Record<ReconciledTotal, number>;

export type UniteReportResult = {
  fromDate: string;
  toDate: string;
  rows: UniteReportRow[];
  reportTotals: ReportTotals;
  rowTotals: ReportTotals;
  reconciled: boolean;
  /** Fixed sentences with column names and counts only. */
  problems: string[];
};

export class UniteReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniteReportError";
  }
}

/** A sheet as rows of primitives; index 0 is spreadsheet row 1 (row positions are kept, blank rows included). */
export type SheetTable = ReadonlyArray<ReadonlyArray<unknown>>;

function fail(message: string): never {
  throw new UniteReportError(message);
}

const headerText = (v: unknown) =>
  typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
const blankCell = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const aed = (mils: number) => mils / 1000;
/** Thousandths -> whole fils, half up (Unite prints its totals to the fils). */
const toFils = (mils: number) => Math.round(mils / 10);

function readTitle(summary: SheetTable): { fromDate: string; toDate: string } {
  for (const row of summary.slice(0, TITLE_SEARCH_ROWS)) {
    const text = cleanText(row[0]);
    const m = text ? TITLE_PATTERN.exec(text) : null;
    if (!m) continue;
    const fromDate = titleDate(m[1], m[2], m[3]);
    const toDate = titleDate(m[4], m[5], m[6]);
    if (!fromDate || !toDate || toDate < fromDate)
      fail("The report title has a date range that is not valid.");
    return { fromDate: fromDate as string, toDate: toDate as string };
  }
  return fail("The Clinic Summary sheet has no 'Daily Collection from … to …' title.");
}

function readReportTotals(summary: SheetTable): ReportTotals {
  const headerIdx = summary.findIndex((row) => {
    const heads = new Set(row.map(headerText));
    return SUMMARY_HEADER_MARKERS.every((h) => heads.has(h));
  });
  if (headerIdx < 0)
    fail("The Clinic Summary sheet has no header row with Gross Amount and Net Billing.");
  const header = summary[headerIdx].map(headerText);
  const col = new Map<ReconciledTotal, number>();
  for (const key of RECONCILED_TOTAL_KEYS) {
    const idx = header.indexOf(RECONCILED_TOTALS[key]);
    if (idx < 0) fail(`The Clinic Summary sheet has no '${RECONCILED_TOTALS[key]}' column.`);
    col.set(key, idx);
  }
  const totalRows = summary
    .map((row, i) => ({ row, i }))
    .filter(({ row, i }) => i > headerIdx && headerText(row[1]) === SUMMARY_TOTAL_LABEL);
  if (totalRows.length !== 1)
    fail(
      `The Clinic Summary sheet must have exactly one '${SUMMARY_TOTAL_LABEL}' row (found ${totalRows.length}).`,
    );
  const { row, i } = totalRows[0];
  const totals = {} as ReportTotals;
  for (const key of RECONCILED_TOTAL_KEYS) {
    const mils = amountMils(row[col.get(key)!]);
    if (mils === "invalid")
      fail(`Clinic Summary row ${i + 1}: '${RECONCILED_TOTALS[key]}' is not a number.`);
    totals[key] = aed(mils as number);
  }
  return totals;
}

type RawLayout = {
  serial: number;
  text: Record<keyof typeof RAW_TEXT_COLUMNS, number>;
  amount: Record<ReportAmountField, number>;
  categories: Array<{ label: string; idx: number }>;
};

function readRawLayout(raw: SheetTable): RawLayout {
  const header = (raw[0] ?? []).map(headerText);
  const first = (name: string) => header.indexOf(name);
  const missing = RAW_REQUIRED_HEADERS.filter((h) => first(h) < 0);
  if (missing.length > 0)
    fail(`The RawData sheet is missing these columns: ${missing.join(", ")}.`);

  const paymentEnd = first(PAYMENT_SECTION_END);
  for (const h of [RAW_AMOUNT_COLUMNS.payment_gateway, RAW_AMOUNT_COLUMNS.other_payment])
    if (first(h) > paymentEnd)
      fail(`The RawData column '${h}' is not in the invoice payment section.`);

  const start = first(CATEGORY_START_AFTER);
  const end = first(CATEGORY_END_BEFORE);
  if (end <= start)
    fail(`The RawData column '${CATEGORY_END_BEFORE}' must come after '${CATEGORY_START_AFTER}'.`);
  const known = new Set([...RAW_REQUIRED_HEADERS, ...RAW_NEVER_READ_HEADERS]);
  const categories: RawLayout["categories"] = [];
  const seen = new Set<string>();
  for (let idx = start + 1; idx < end; idx++) {
    const label = cleanText(header[idx]);
    if (!label) continue; // an untitled column is never read
    if (known.has(label))
      fail(`The RawData column '${label}' is inside the service category block.`);
    if (seen.has(label)) fail(`The RawData category column '${label}' appears twice.`);
    seen.add(label);
    categories.push({ label, idx });
  }

  const text = {} as RawLayout["text"];
  for (const [field, h] of Object.entries(RAW_TEXT_COLUMNS))
    text[field as keyof typeof RAW_TEXT_COLUMNS] = first(h);
  const amount = {} as RawLayout["amount"];
  for (const field of REPORT_AMOUNT_FIELDS) amount[field] = first(RAW_AMOUNT_COLUMNS[field]);
  return { serial: first(SERIAL_HEADER), text, amount, categories };
}

/** The sheet tables -> the parsed report. Throws UniteReportError when the file cannot be trusted. */
export function parseUniteReportTables(summary: SheetTable, raw: SheetTable): UniteReportResult {
  const { fromDate, toDate } = readTitle(summary);
  const reportTotals = readReportTotals(summary);
  const layout = readRawLayout(raw);

  const dataRows = raw
    .map((cells, i) => ({ cells, rowNo: i + 1 }))
    .filter(({ cells, rowNo }) => rowNo > 1 && !blankCell(cells[layout.serial]));
  if (dataRows.length === 0) fail("The RawData sheet has no rows.");
  if (dataRows.length > MAX_REPORT_ROWS)
    fail(`The RawData sheet has more than ${MAX_REPORT_ROWS} rows; upload one month at a time.`);

  const sumMils = Object.fromEntries(RECONCILED_TOTAL_KEYS.map((k) => [k, 0])) as ReportTotals;
  const rows: UniteReportRow[] = [];
  let outOfRange = 0;
  let noDoctor = 0;

  for (const { cells, rowNo } of dataRows) {
    const at = (field: keyof typeof RAW_TEXT_COLUMNS) => cells[layout.text[field]];
    const where = (column: string) => `RawData row ${rowNo}: '${column}'`;

    const visitCell = at("visit_at");
    const invoiceCell = at("invoice_date");
    if (!blankCell(visitCell) && !(visitCell instanceof Date && !Number.isNaN(visitCell.getTime())))
      fail(`${where(RAW_TEXT_COLUMNS.visit_at)} is not a date.`);
    if (
      !blankCell(invoiceCell) &&
      !(invoiceCell instanceof Date && !Number.isNaN(invoiceCell.getTime()))
    )
      fail(`${where(RAW_TEXT_COLUMNS.invoice_date)} is not a date.`);
    const visit = visitCell instanceof Date ? visitCell : null;
    const invoice = invoiceCell instanceof Date ? invoiceCell : null;
    if (!visit && !invoice)
      fail(`RawData row ${rowNo} has neither a visit date nor an invoice date.`);
    // exceljs gives the Excel wall clock in the UTC fields; the wall clock is Dubai time (UTC+4, no DST)
    const visitAt = visit ? new Date(visit.getTime() - DUBAI_OFFSET_MS).toISOString() : null;
    const invoiceDate = invoice ? ymd(invoice) : null;
    const reportDate = invoiceDate ?? ymd(visit!);
    if (reportDate < fromDate || reportDate > toDate) outOfRange++;

    const status = visitStatus(at("visit_status"));
    if (status === "invalid")
      fail(`${where(RAW_TEXT_COLUMNS.visit_status)} has a value that is not recognised.`);
    const cancelled = recordCancelled(at("record_status"));
    if (cancelled === "invalid")
      fail(`${where(RAW_TEXT_COLUMNS.record_status)} has a value that is not recognised.`);

    const ids = {} as Record<
      "patient_pin" | "selfpay_invoice_no" | "insurance_invoice_no" | "invoice_type",
      string | null
    >;
    for (const field of [
      "patient_pin",
      "selfpay_invoice_no",
      "insurance_invoice_no",
      "invoice_type",
    ] as const) {
      const v = idText(at(field));
      if (v === "invalid") fail(`${where(RAW_TEXT_COLUMNS[field])} is not a valid value.`);
      ids[field] = v as string | null;
    }

    const doctor = cleanText(at("doctor_name"));
    if (!doctor) noDoctor++;
    const amounts = {} as Record<ReportAmountField, number>;
    for (const field of REPORT_AMOUNT_FIELDS) {
      const mils = amountMils(cells[layout.amount[field]]);
      if (mils === "invalid") fail(`${where(RAW_AMOUNT_COLUMNS[field])} is not a number.`);
      amounts[field] = aed(mils as number);
      if (field in sumMils) sumMils[field as ReconciledTotal] += mils as number;
    }
    const categories: Record<string, number> = {};
    for (const { label, idx } of layout.categories) {
      const mils = amountMils(cells[idx]);
      if (mils === "invalid") fail(`${where(label)} is not a number.`);
      if (mils !== 0) categories[label] = aed(mils as number);
    }

    rows.push({
      row_no: rowNo,
      visit_at: visitAt,
      invoice_date: invoiceDate,
      report_date: reportDate,
      department: cleanText(at("department")),
      doctor_name: doctor ? doctorDisplayName(doctor) : NO_DOCTOR_NAME,
      doctor_key: doctor ? normaliseDoctorKey(doctor) || NO_DOCTOR_KEY : NO_DOCTOR_KEY,
      clinic_name: cleanText(at("clinic_name")),
      patient_pin: ids.patient_pin,
      visit_status: status,
      invoice_type: ids.invoice_type,
      selfpay_invoice_no: ids.selfpay_invoice_no,
      insurance_invoice_no: ids.insurance_invoice_no,
      categories,
      is_cancelled: cancelled as boolean,
      ...amounts,
    });
  }

  if (outOfRange > 0)
    fail(`${outOfRange} rows dated outside the report range ${fromDate} to ${toDate}.`);

  const rowTotals = {} as ReportTotals;
  const problems: string[] = [];
  for (const key of RECONCILED_TOTAL_KEYS) {
    rowTotals[key] = toFils(sumMils[key]) / 100;
    if (toFils(sumMils[key]) !== Math.round(reportTotals[key] * 100))
      problems.push(
        `${RECONCILED_TOTALS[key]}: the rows do not add up to the report's Invoice Total.`,
      );
  }
  const reconciled = problems.length === 0;
  if (noDoctor > 0)
    problems.push(`${noDoctor} rows have no doctor name; they are kept as '${NO_DOCTOR_NAME}'.`);
  return { fromDate, toDate, rows, reportTotals, rowTotals, reconciled, problems };
}

/** Reads one sheet keeping row positions (index 0 = row 1). Never called for any sheet but the two above. */
function sheetTable(
  wb: {
    worksheets: Array<{
      name: string;
      rowCount: number;
      columnCount: number;
      getRow(n: number): { getCell(c: number): { value: unknown } };
    }>;
  },
  name: string,
  maxRows: number,
): unknown[][] {
  const sheet = wb.worksheets.find((s) => s.name.trim() === name);
  if (!sheet) return fail(`The workbook has no '${name}' sheet.`);
  if (sheet.rowCount > maxRows + 1) fail(`The '${name}' sheet has more than ${maxRows} rows.`);
  const width = sheet.columnCount;
  const table: unknown[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellToPrimitive(row.getCell(c).value));
    table.push(cells);
  }
  return table;
}

/** The uploaded workbook -> the parsed report (reads only "Clinic Summary" and "RawData"). */
export async function parseUniteReport(buffer: Buffer | ArrayBuffer): Promise<UniteReportResult> {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  if (!(bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b))
    fail("This is not an .xlsx file. Upload the report exported from Unite.");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as never);
  } catch {
    fail("The workbook could not be opened. Upload the report exported from Unite.");
  }
  const summary = sheetTable(wb as never, SUMMARY_SHEET, MAX_SUMMARY_ROWS);
  const raw = sheetTable(wb as never, RAW_SHEET, MAX_REPORT_ROWS);
  return parseUniteReportTables(summary, raw);
}
