/**
 * Synthetic Unite "Daily Collection Multi-Clinic Report" workbook for tests (Phase 23A). Made-up names, PINs and amounts
 * only; the layout follows the real export (title row, Clinic Summary "Invoice Total" row, RawData with the repeated
 * PAYMENT GATEWAY / OTHERS / OTHERS PAYMENT MODE headers, STATUS vs Status, a varying category block, and a
 * " Cash Receipt Details" sheet that must never be read). Cells Pulse must never read hold SENTINELS.
 */

/** Strings that must never appear in anything the parser returns. */
export const SENTINELS = {
  patientName: "Layla Demo-07 SENTINEL-NAME",
  cardNo: "SENTINEL-CARD-784",
  insurer: "SENTINEL-INSURER",
  remarks: "SENTINEL-REMARKS",
  insuranceRemarks: "SENTINEL-SITE-TAG",
  referralDoctor: "SENTINEL-REFERRAL-DR",
  referralClinic: "SENTINEL-REFERRAL-CLINIC",
  invoicedBy: "SENTINEL-STAFF-INVOICED",
  modifiedBy: "SENTINEL-STAFF-MODIFIED",
  paymentMode: "SENTINEL-PAYMENT-MODE",
  cashReceiptName: "SENTINEL-CASH-RECEIPT-NAME",
} as const;

export const CATEGORY_HEADERS = [
  "DENTAL PROCEDURES",
  "NO",
  "OTHER SERVICES",
  "Package",
  "PACKAGES",
  "PROCEDURES",
  "TEST",
] as const;

export const RAW_HEADERS: string[] = [
  "",
  "S.NO",
  "VISIT DATE",
  "INVOICE DATE",
  "DEPARTMENT NAME",
  "DOCTOR NAME",
  "CLINIC NAME",
  "REFERRAL DOCTOR NAME",
  "REFERRAL CLINIC NAME",
  "PIN NO",
  "PATIENT NAME",
  "STATUS",
  "SELFPAY INVOICE NO",
  "INSURANCE INVOICE NO",
  "INSURANCE",
  "INSURANCE CARD NO",
  ...CATEGORY_HEADERS,
  "GROSS AMT",
  "DISCOUNT",
  "SPECIAL DISCOUNT",
  "VAT AMOUNT",
  "NET BILLING",
  "TOTAL INVOICE AMT",
  "CASH",
  "CARD",
  "BANK TRANSFER",
  "PAYMENT GATEWAY",
  "OTHERS",
  "OTHERS PAYMENT MODE",
  "PATIENT SHARE",
  "INSURANCE CLAIM",
  "TOTAL ADVANCE CASH",
  "TOTAL ADVANCE CARD",
  "TOTAL ADVANCE BANK TRANSFER",
  "TOTAL ADVANCE PAYMENT GATEWAY",
  "TOTAL ADVANCE  OTHERS",
  "TOTAL ADVANCE  OTHERS PAYMNET MODE",
  "TOTAL ADVANCE CONSUMPTION",
  "TOTAL CREDIT NOTE CONSUMPTION",
  "OUTSTANDING COLLECTION (CASH)",
  "OUTSTANDING COLLECTION (CC)",
  "OUTSTANDING COLLECTION (BANK TRANSFER)",
  "OUTSTANDING COLLECTION (PAYMENT GATEWAY)",
  "OUTSTANDING COLLECTION (OTHERS)",
  "OUTSTANDING COLLECTION (OTHERS PAYMENT MODE)",
  "CASH COLLECTION",
  "CC COLLECTION",
  "BANKT RANSFER COLLECTION",
  "PAYMENT GATEWAY",
  "OTHERS",
  "OTHERS PAYMENT MODE",
  "DD AMT",
  "OUTSTANDING CREDIT",
  "WRITE OFF AMT",
  "REFUND AMOUNT",
  "INVOICE TYPE",
  "INVOICED BY",
  "MODIFIED BY",
  "Status",
  "REMARKS",
  "INSURANCE REMARKS",
];

export type FixtureRow = {
  visit: Date | null; // Dubai wall clock written in the UTC fields (as Unite / exceljs do)
  invoice: Date | null;
  dept: string;
  doctor: string;
  clinic: string;
  pin: string | number | null;
  status: string | null; // visit STATUS
  record: string | null; // record Status
  selfpay: string | null;
  insurance: string | null;
  invType: string | null;
  categories: Partial<Record<(typeof CATEGORY_HEADERS)[number], number>>;
  gross: number;
  discount: number;
  vat: number;
  net: number;
  total: number;
  cash?: number;
  card?: number;
  bank?: number;
  gateway?: number; // first PAYMENT GATEWAY
  others?: number; // first OTHERS
  patientShare?: number;
  insuranceClaim?: number;
  advance?: number;
  creditNote?: number;
  outstanding?: number;
  writeOff?: number;
  refund?: number;
};

/** Wall-clock date-time as exceljs returns it (UTC fields = the Excel value). */
export const wall = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm));

export const DEFAULT_ROWS: FixtureRow[] = [
  {
    // self-pay, invoiced the same day
    visit: wall(2026, 9, 1, 9, 15),
    invoice: wall(2026, 9, 1),
    dept: "Dermatology",
    doctor: "Dr. Omar Testdoc",
    clinic: "Al Das Synthetic Clinic One",
    pin: 900000001,
    status: "New",
    record: "Active",
    selfpay: "SP-0001",
    insurance: null,
    invType: "SELF PAID",
    categories: { PROCEDURES: 500 },
    gross: 500,
    discount: 50,
    vat: 22.5,
    net: 450,
    total: 472.5,
    cash: 472.5,
  },
  {
    // unbilled visit just after midnight Dubai time (UTC is still the previous day)
    visit: wall(2026, 9, 1, 2, 0),
    invoice: null,
    dept: "Dermatology",
    doctor: "Dr.Omar Testdoc",
    clinic: "Al Das Synthetic Clinic One",
    pin: "900000002",
    status: "Revisit",
    record: "Active",
    selfpay: null,
    insurance: null,
    invType: null,
    categories: {},
    gross: 0,
    discount: 0,
    vat: 0,
    net: 0,
    total: 0,
  },
  {
    // invoice date only, NBSP in the doctor's name, the "NO" / "Package" / "PACKAGES" categories
    visit: null,
    invoice: wall(2026, 9, 15),
    dept: "Dermatology",
    doctor: "dr omar  testdoc",
    clinic: "Al Das Synthetic Clinic Two",
    pin: 900000003,
    status: "Follow-up",
    record: null,
    selfpay: null,
    insurance: "INS-0004",
    invType: "INSURANCE",
    categories: { NO: 100, Package: 200, PACKAGES: 300 },
    gross: 600,
    discount: 0,
    vat: 30,
    net: 600,
    total: 630,
    card: 63,
    patientShare: 63,
    insuranceClaim: 567,
  },
  {
    // cancelled: still in Unite's totals
    visit: wall(2026, 9, 30, 21, 0),
    invoice: wall(2026, 9, 30),
    dept: "Dentistry",
    doctor: "Dr. Sara Example",
    clinic: "Al Das Synthetic Clinic One",
    pin: 900000004,
    status: "New",
    record: "Cancel",
    selfpay: "SP-0005",
    insurance: "INS-0005",
    invType: "INSURANCE, SELF PAID",
    categories: { TEST: 80.25, "DENTAL PROCEDURES": 19.75 },
    gross: 100,
    discount: 0,
    vat: 5,
    net: 100,
    total: 105,
    gateway: 50,
    others: 55,
    patientShare: 55,
    insuranceClaim: 50,
  },
  {
    // amounts that drift in floating point (0.1 + 0.2), and the other money columns
    visit: wall(2026, 9, 10, 16, 45),
    invoice: wall(2026, 9, 10),
    dept: "General Practice",
    doctor: "  Dr.  Sara   Example ",
    clinic: "Al Das Synthetic Clinic Three",
    pin: null,
    status: null,
    record: "Active",
    selfpay: "SP-0006",
    insurance: null,
    invType: "SELF PAID",
    categories: { "OTHER SERVICES": 0.3 },
    gross: 0.3,
    discount: 0,
    vat: 0,
    net: 0.3,
    total: 0.3,
    cash: 0.1,
    bank: 0.2,
    advance: 3,
    creditNote: 4,
    outstanding: 5,
    writeOff: 2,
    refund: 1,
  },
];

const TOTAL_KEYS = [
  ["Gross Amount", (r: FixtureRow) => r.gross],
  ["Discount", (r: FixtureRow) => r.discount],
  ["VATAmount", (r: FixtureRow) => r.vat],
  ["Net Billing", (r: FixtureRow) => r.net],
  ["Total", (r: FixtureRow) => r.total],
  ["Cash", (r: FixtureRow) => r.cash ?? 0],
  ["Card", (r: FixtureRow) => r.card ?? 0],
  ["", () => null],
  ["Bank Transfer", (r: FixtureRow) => r.bank ?? 0],
  ["Payment Gateway", (r: FixtureRow) => r.gateway ?? 0],
  ["Others", (r: FixtureRow) => r.others ?? 0],
  ["Patient Share", (r: FixtureRow) => r.patientShare ?? 0],
  ["Insurance Claim", (r: FixtureRow) => r.insuranceClaim ?? 0],
  ["Advance Consumption", () => 999.99], // a different basis in Unite: never reconciled
] as const;

export type WorkbookOptions = {
  rows?: FixtureRow[];
  title?: string;
  /** Added to the "Invoice Total" cell of that Clinic Summary column. */
  tamper?: Record<string, number>;
  /** RawData header removed (its cells too). */
  omitHeader?: string;
  /** Raw cell overrides: data row index (0-based) and header (first occurrence). */
  cells?: Array<{ row: number; header: string; value: unknown }>;
  /** Header list to use instead of RAW_HEADERS (cells are matched by first occurrence). */
  headers?: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function rawCells(r: FixtureRow, i: number, headers: string[]): unknown[] {
  const byHeader: Record<string, unknown> = {
    "S.NO": i + 1,
    "VISIT DATE": r.visit,
    "INVOICE DATE": r.invoice,
    "DEPARTMENT NAME": r.dept,
    "DOCTOR NAME": r.doctor,
    "CLINIC NAME": r.clinic,
    "REFERRAL DOCTOR NAME": SENTINELS.referralDoctor,
    "REFERRAL CLINIC NAME": SENTINELS.referralClinic,
    "PIN NO": r.pin,
    "PATIENT NAME": SENTINELS.patientName,
    STATUS: r.status,
    "SELFPAY INVOICE NO": r.selfpay,
    "INSURANCE INVOICE NO": r.insurance,
    INSURANCE: SENTINELS.insurer,
    "INSURANCE CARD NO": SENTINELS.cardNo,
    ...r.categories,
    "GROSS AMT": r.gross,
    DISCOUNT: r.discount,
    "SPECIAL DISCOUNT": 0,
    "VAT AMOUNT": r.vat,
    "NET BILLING": r.net,
    "TOTAL INVOICE AMT": r.total,
    CASH: r.cash ?? 0,
    CARD: r.card ?? 0,
    "BANK TRANSFER": r.bank ?? null,
    "PAYMENT GATEWAY": r.gateway ?? 0,
    OTHERS: r.others ?? 0,
    "OTHERS PAYMENT MODE": SENTINELS.paymentMode,
    "PATIENT SHARE": r.patientShare ?? 0,
    "INSURANCE CLAIM": r.insuranceClaim ?? 0,
    "TOTAL ADVANCE CONSUMPTION": r.advance ?? 0,
    "TOTAL CREDIT NOTE CONSUMPTION": r.creditNote ?? 0,
    "DD AMT": 7,
    "OUTSTANDING CREDIT": r.outstanding ?? 0,
    "WRITE OFF AMT": r.writeOff ?? 0,
    "REFUND AMOUNT": r.refund ?? 0,
    "INVOICE TYPE": r.invType,
    "INVOICED BY": SENTINELS.invoicedBy,
    "MODIFIED BY": SENTINELS.modifiedBy,
    Status: r.record,
    REMARKS: SENTINELS.remarks,
    "INSURANCE REMARKS": SENTINELS.insuranceRemarks,
  };
  const seen = new Set<string>();
  return headers.map((h) => {
    if (h === "") return null;
    if (seen.has(h)) {
      // the second PAYMENT GATEWAY / OTHERS (collection section) hold different numbers; never read
      if (h === "PAYMENT GATEWAY") return 999;
      if (h === "OTHERS") return 888;
      if (h === "OTHERS PAYMENT MODE") return SENTINELS.paymentMode;
      return null;
    }
    seen.add(h);
    return h in byHeader ? byHeader[h] : 0;
  });
}

/** Builds the workbook and returns the .xlsx bytes. */
export async function buildUniteReportWorkbook(opts: WorkbookOptions = {}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const rows = opts.rows ?? DEFAULT_ROWS;
  let headers = opts.headers ?? RAW_HEADERS;
  const omitIdx = opts.omitHeader ? headers.indexOf(opts.omitHeader) : -1;

  // Clinic Summary
  const summary = wb.addWorksheet("Clinic Summary");
  summary.addRow(["Al Das Synthetic Medical Centre"]);
  summary.addRow([
    opts.title ??
      "Daily Collection from 01-Sep-2026  to 30-Sep-2026 | Generated On: 14-Oct-2026 05:34",
  ]);
  summary.addRow([]);
  summary.addRow(["Date", "Doctor Name", ...CATEGORY_HEADERS, ...TOTAL_KEYS.map(([h]) => h)]);
  summary.addRow([
    "01-Sep-2026",
    "Dr. Omar Testdoc",
    ...CATEGORY_HEADERS.map(() => 0),
    ...TOTAL_KEYS.map(() => 1),
  ]);
  summary.addRow([
    "",
    "Invoice Total",
    ...CATEGORY_HEADERS.map(() => 0),
    ...TOTAL_KEYS.map(([h, f]) => {
      if (h === "") return null;
      const sum = round2(rows.reduce((a, r) => a + ((f(r) as number | null) ?? 0), 0));
      return round2(sum + (opts.tamper?.[h] ?? 0));
    }),
  ]);

  // RawData
  const raw = wb.addWorksheet("RawData");
  const cellsFor = (r: FixtureRow, i: number) => {
    const cells = rawCells(r, i, headers);
    for (const o of opts.cells ?? []) if (o.row === i) cells[headers.indexOf(o.header)] = o.value;
    return cells;
  };
  const body = rows.map(cellsFor);
  if (omitIdx >= 0) {
    headers = headers.filter((_, i) => i !== omitIdx);
    body.forEach((cells, i) => (body[i] = cells.filter((_, j) => j !== omitIdx)));
  }
  raw.addRow(headers.map((h) => (h === "" ? null : h)));
  for (const cells of body) raw.addRow(cells);
  // a footer line without S.NO (not a data row)
  const footer = headers.map(() => null as unknown);
  footer[headers.indexOf("GROSS AMT")] = 123456;
  raw.addRow(footer);

  // Cash receipts: never read
  const cash = wb.addWorksheet(" Cash Receipt Details");
  cash.addRow(["S.NO", "PIN NO", "NAME", "AMOUNT"]);
  cash.addRow([1, 900000001, SENTINELS.cashReceiptName, 10]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
