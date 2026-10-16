/**
 * The ONLY place that knows the layout of the Unite "Daily Collection Multi-Clinic Report" (.xlsx), Phase 23A
 * (docs/39_UNITE_REPORTS_PLAN.md, docs/23_PHASE_23A_NOTES.md).
 *
 * - Only two sheets are read: "Clinic Summary" (the title with the date range and the "Invoice Total" row) and "RawData"
 *   (one row per visit). The " Cash Receipt Details" sheet is never read.
 * - Headers are matched exactly after trimming, case-sensitively: RawData has both "STATUS" (visit: New / Revisit) and
 *   "Status" (record: Active / Cancel). Some headers repeat (PAYMENT GATEWAY, OTHERS, OTHERS PAYMENT MODE); the FIRST
 *   occurrence (the invoice payment section, before PATIENT SHARE) is the one read.
 * - A column that is not listed here is NEVER read. The one structural exception is the service-category block: every
 *   column strictly between INSURANCE CARD NO and GROSS AMT is a category whose header is its label, read as an amount.
 * - Never read: patient name, insurance card number, insurer text, remarks, referral doctor and clinic, the staff who
 *   invoiced or modified, the payment-mode free text, the collection and outstanding sections other than those mapped.
 */

/** Sheet names (trimmed before comparing). */
export const SUMMARY_SHEET = "Clinic Summary";
export const RAW_SHEET = "RawData";

/** Size and row caps (a monthly file has a few thousand rows; history is loaded month by month). */
export const MAX_REPORT_BYTES = 25 * 1024 * 1024;
export const MAX_REPORT_ROWS = 30_000;
/** How far down the Clinic Summary sheet the header row and the "Invoice Total" row are looked for. */
export const MAX_SUMMARY_ROWS = 2_000;

/** "Daily Collection from 01-Sep-2026  to 30-Sep-2026 | Generated On: ..." (spacing is tolerated). */
export const TITLE_PATTERN =
  /Daily\s+Collection\s+from\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+to\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/i;
/** A one-day export: "Daily Collection for 14-Oct-2026 | Generated On: ..." (from = to). */
export const ONE_DAY_TITLE_PATTERN = /Daily\s+Collection\s+for\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/i;
/** The title is looked for in column A of the first rows of the Clinic Summary sheet. */
export const TITLE_SEARCH_ROWS = 6;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "01", "Sep", "2026" -> "2026-09-01"; null when it is not a real date. */
export function titleDate(day: string, month: string, year: string): string | null {
  const m = MONTHS.indexOf(month.toLowerCase());
  const d = Number(day);
  const y = Number(year);
  if (m < 0) return null;
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// ---- RawData ------------------------------------------------------------------------------------------------------

/** Marks a data row (a row is data when this cell is not blank). */
export const SERIAL_HEADER = "S.NO";
/** The category block lies strictly between these two headers. */
export const CATEGORY_START_AFTER = "INSURANCE CARD NO";
export const CATEGORY_END_BEFORE = "GROSS AMT";
/** The first PAYMENT GATEWAY / OTHERS must come before this header (the invoice payment section). */
export const PAYMENT_SECTION_END = "PATIENT SHARE";

/** Text and date columns read from RawData -> the fin_report_visits field they feed. */
export const RAW_TEXT_COLUMNS = {
  visit_at: "VISIT DATE",
  invoice_date: "INVOICE DATE",
  department: "DEPARTMENT NAME",
  doctor_name: "DOCTOR NAME",
  clinic_name: "CLINIC NAME",
  patient_pin: "PIN NO",
  visit_status: "STATUS",
  selfpay_invoice_no: "SELFPAY INVOICE NO",
  insurance_invoice_no: "INSURANCE INVOICE NO",
  invoice_type: "INVOICE TYPE",
  record_status: "Status",
} as const;

/** Amount columns read from RawData -> the fin_report_visits column (AED). First occurrence wins. */
export const RAW_AMOUNT_COLUMNS = {
  gross: "GROSS AMT",
  discount: "DISCOUNT",
  vat: "VAT AMOUNT",
  net: "NET BILLING",
  total: "TOTAL INVOICE AMT",
  cash: "CASH",
  card: "CARD",
  bank_transfer: "BANK TRANSFER",
  payment_gateway: "PAYMENT GATEWAY",
  other_payment: "OTHERS",
  patient_share: "PATIENT SHARE",
  insurance_claim: "INSURANCE CLAIM",
  advance_consumed: "TOTAL ADVANCE CONSUMPTION",
  credit_note_consumed: "TOTAL CREDIT NOTE CONSUMPTION",
  outstanding_credit: "OUTSTANDING CREDIT",
  write_off: "WRITE OFF AMT",
  refund: "REFUND AMOUNT",
} as const;

export type ReportAmountField = keyof typeof RAW_AMOUNT_COLUMNS;
export const REPORT_AMOUNT_FIELDS = Object.keys(RAW_AMOUNT_COLUMNS) as ReportAmountField[];

/** Every header that must be present in RawData. */
export const RAW_REQUIRED_HEADERS: readonly string[] = [
  SERIAL_HEADER,
  CATEGORY_START_AFTER,
  ...Object.values(RAW_TEXT_COLUMNS),
  ...Object.values(RAW_AMOUNT_COLUMNS),
];

/**
 * Headers that are known but never read (personal, staff or free-text data, or sections Pulse does not use). Listed so
 * a misplaced one inside the category block is refused rather than read as an amount.
 */
export const RAW_NEVER_READ_HEADERS: readonly string[] = [
  "PATIENT NAME",
  "INSURANCE CARD NO",
  "INSURANCE",
  "REFERRAL DOCTOR NAME",
  "REFERRAL CLINIC NAME",
  "REMARKS",
  "INSURANCE REMARKS",
  "INVOICED BY",
  "MODIFIED BY",
  "OTHERS PAYMENT MODE",
  "SPECIAL DISCOUNT",
  "DD AMT",
];

// ---- Clinic Summary -----------------------------------------------------------------------------------------------

/** Column B of the row that holds the report's own totals. */
export const SUMMARY_TOTAL_LABEL = "Invoice Total";

/**
 * The 12 columns that must reconcile: the sum of the RawData rows (cancelled rows included) equals the Clinic Summary
 * "Invoice Total" row to the fils. TOTAL ADVANCE CONSUMPTION is on a different basis and is not reconciled.
 */
export const RECONCILED_TOTALS = {
  gross: "Gross Amount",
  discount: "Discount",
  vat: "VATAmount",
  net: "Net Billing",
  total: "Total",
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank Transfer",
  payment_gateway: "Payment Gateway",
  other_payment: "Others",
  patient_share: "Patient Share",
  insurance_claim: "Insurance Claim",
} as const satisfies Partial<Record<ReportAmountField, string>>;

export type ReconciledTotal = keyof typeof RECONCILED_TOTALS;
export const RECONCILED_TOTAL_KEYS = Object.keys(RECONCILED_TOTALS) as ReconciledTotal[];

/** The Clinic Summary header row is the one that carries all of these. */
export const SUMMARY_HEADER_MARKERS: readonly string[] = [
  "Doctor Name",
  "Gross Amount",
  "Net Billing",
];

// ---- value helpers ------------------------------------------------------------------------------------------------

/** Trimmed text with non-breaking spaces turned into spaces and runs of whitespace collapsed; null when blank. */
export function cleanText(v: unknown): string | null {
  if (v == null) return null;
  const s = (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
}

/** Display name of a doctor: trimmed, whitespace collapsed. */
export const doctorDisplayName = (name: string): string => cleanText(name) ?? "";

/**
 * Normalised doctor key, so the spellings Unite produces for one doctor group together:
 * "Dr. Latife cilli", "Dr.Latife Cilli" and "dr latife  cilli" -> "latife cilli". Lowercase, NBSP -> space, a leading
 * "dr" / "dr." token removed (only when followed by a dot or a space, so "Drew" stays), dots removed, whitespace
 * collapsed and trimmed.
 */
export function normaliseDoctorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, " ")
    .trim()
    .replace(/^dr(?:\.\s*|\s+)/, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shown and keyed for a row whose DOCTOR NAME is blank (direct sales); kept so the totals still reconcile. */
export const NO_DOCTOR_NAME = "(no doctor)";
export const NO_DOCTOR_KEY = "(no doctor)";

export type VisitStatus = "new" | "revisit" | "followup";

/** Visit STATUS -> closed value; null when blank; "invalid" for anything else. */
export function visitStatus(v: unknown): VisitStatus | null | "invalid" {
  const s = cleanText(v);
  if (s === null) return null;
  const k = s.toLowerCase().replace(/[\s-]/g, "");
  if (k === "new") return "new";
  if (k === "revisit") return "revisit";
  if (k === "followup") return "followup";
  return "invalid";
}

/** Record "Status" -> cancelled?; blank and Active are not; "invalid" for anything else. */
export function recordCancelled(v: unknown): boolean | "invalid" {
  const s = cleanText(v);
  if (s === null) return false;
  const k = s.toLowerCase();
  if (k === "active") return false;
  if (k === "cancel" || k === "cancelled" || k === "canceled") return true;
  return "invalid";
}

/**
 * Amount cell -> integer thousandths of an AED; blank -> 0; "invalid" for anything that is not a number. Unite keeps
 * some amounts to three decimals (e.g. 178799.245), so rounding each row to the fils would drift from its totals.
 */
export function amountMils(v: unknown): number | "invalid" {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1000) : "invalid";
  if (typeof v === "string") {
    const s = v.replace(/,/g, "").trim();
    if (s === "" || s === "-") return 0;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return "invalid";
    return Math.round(Number(s) * 1000);
  }
  return "invalid";
}

/** Short identifier text (PIN, invoice number, invoice type): numbers keep their digits, text is trimmed. */
export function idText(v: unknown, maxLength = 60): string | null | "invalid" {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "invalid";
  if (typeof v !== "string") return "invalid";
  const s = cleanText(v);
  if (s === null) return null;
  return s.length > maxLength ? "invalid" : s;
}

/** Dubai has no daylight saving: wall clock = UTC + 4 h. */
export const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
