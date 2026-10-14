import { z } from "zod";

import { coverageOf, type Coverage, type DateRange } from "@/lib/finance/doctor-performance";

/**
 * Collections and data quality from the Unite collection report (Phase 23D, docs/23_PHASE_23D_NOTES.md). Pure: the
 * sums and counts come from public.fin_collections_inputs() (SQL); this module parses them, adds the total collected,
 * buckets the invoice types, words the data-quality signals and works out the reconciliation line, so the page and
 * the Excel download agree.
 *
 * The signals are review signals, never proof. The reconciliation line shows a difference and never asserts it is
 * zero: Unite's columns are not guaranteed to add up, and Pulse never guesses why.
 */

export const DEFAULT_LATE_INVOICE_DAYS = 3;

// ---------------------------------------------------------------------------
// Sums
// ---------------------------------------------------------------------------

export type Sums = {
  rows: number;
  cash: number;
  card: number;
  bankTransfer: number;
  paymentGateway: number;
  otherPayment: number;
  /** cash + card + bank transfer + payment gateway + other payment. */
  collected: number;
  patientShare: number;
  insuranceClaim: number;
  net: number;
  advanceConsumed: number;
  creditNoteConsumed: number;
  outstandingCredit: number;
  writeOff: number;
  refund: number;
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * Unite keeps some amounts to three decimals; sums are exact to 0.001 in SQL. Here amounts are only added in
 * thousandths and cleaned of binary float noise (never rounded to the fil); screens and the workbook round for display.
 */
const mils = (v: number) => Math.round(v * 1000);
const add = (...xs: number[]) => xs.reduce((a, x) => a + mils(x), 0) / 1000;

function sums(r: Raw): Sums {
  const cash = n(r.cash);
  const card = n(r.card);
  const bankTransfer = n(r.bank_transfer);
  const paymentGateway = n(r.payment_gateway);
  const otherPayment = n(r.other_payment);
  return {
    rows: n(r.rows),
    cash,
    card,
    bankTransfer,
    paymentGateway,
    otherPayment,
    collected: add(cash, card, bankTransfer, paymentGateway, otherPayment),
    patientShare: n(r.patient_share),
    insuranceClaim: n(r.insurance_claim),
    net: n(r.net),
    advanceConsumed: n(r.advance_consumed),
    creditNoteConsumed: n(r.credit_note_consumed),
    outstandingCredit: n(r.outstanding_credit),
    writeOff: n(r.write_off),
    refund: n(r.refund),
  };
}

export const UNKNOWN_BRANCH_LABEL = "Unknown branch (clinic not mapped)";

/** The payment and share columns, in the order every table shows them. */
export const SUM_COLUMNS: readonly (readonly [Exclude<keyof Sums, "rows">, string])[] = [
  ["cash", "Cash"],
  ["card", "Card"],
  ["bankTransfer", "Bank transfer"],
  ["paymentGateway", "Payment gateway"],
  ["otherPayment", "Other payment"],
  ["collected", "Total collected"],
  ["patientShare", "Patient share"],
  ["insuranceClaim", "Insurance claim"],
  ["net", "Net billing"],
  ["advanceConsumed", "Advance consumed"],
  ["creditNoteConsumed", "Credit note consumed"],
  ["outstandingCredit", "Outstanding credit"],
  ["writeOff", "Write-off"],
  ["refund", "Refund"],
];

// ---------------------------------------------------------------------------
// Invoice types
// ---------------------------------------------------------------------------

export type InvoiceBucket = "self_pay" | "insurance" | "both" | "blank" | "other";
export const INVOICE_BUCKETS: readonly InvoiceBucket[] = [
  "self_pay",
  "insurance",
  "both",
  "blank",
  "other",
];
export const INVOICE_BUCKET_LABEL: Record<InvoiceBucket, string> = {
  self_pay: "Self-pay",
  insurance: "Insurance",
  both: "Self-pay and insurance",
  blank: "Invoice type blank",
  other: "Invoice type not recognised",
};

/**
 * Unite's invoice type: SELF PAID, INSURANCE, both joined (e.g. "INSURANCE, SELF PAID"), or blank. Closed list: any
 * other word puts the row in "other", it is never guessed.
 */
export function invoiceBucket(raw: string | null | undefined): InvoiceBucket {
  const s = (raw ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  if (!s) return "blank";
  const parts = s
    .split(/[,;/&+]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "blank";
  const kinds = new Set<string>();
  for (const p of parts) {
    if (p === "SELF PAID") kinds.add("self");
    else if (p === "INSURANCE") kinds.add("insurance");
    else return "other";
  }
  if (kinds.size === 2) return "both";
  return kinds.has("self") ? "self_pay" : "insurance";
}

// ---------------------------------------------------------------------------
// Data-quality signals
// ---------------------------------------------------------------------------

export type SignalKey =
  | "no_invoice"
  | "late_invoice"
  | "earlier_month"
  | "unknown_branch"
  | "category_no"
  | "blank_visit_status"
  | "blank_invoice_type"
  | "cancelled";

export const SIGNAL_KEYS: readonly SignalKey[] = [
  "no_invoice",
  "late_invoice",
  "earlier_month",
  "unknown_branch",
  "category_no",
  "blank_visit_status",
  "blank_invoice_type",
  "cancelled",
];

type SignalText = {
  title: string;
  /** The fixed sentence: what the rows have in common. */
  sentence: (s: { lateDays: number }) => string;
  /** What Finance does about it. */
  action: string;
};

export const SIGNAL_TEXT: Record<SignalKey, SignalText> = {
  no_invoice: {
    title: "Visits without an invoice",
    sentence: () => "Visit rows with no self-pay or insurance invoice number and a net of 0.",
    action:
      "Check in Unite whether the visit should have been billed (for example radiology billed under the referring doctor) or was a free follow-up.",
  },
  late_invoice: {
    title: "Late invoices",
    sentence: ({ lateDays }) =>
      `Invoices raised more than ${lateDays} ${lateDays === 1 ? "day" : "days"} after the visit.`,
    action:
      "Ask the front desk or billing why the invoice waited; repeated delays move revenue between days and months.",
  },
  earlier_month: {
    title: "Invoices for visits in an earlier month",
    sentence: () => "Invoices dated this month for visits from an earlier month.",
    action:
      "Confirm each was a genuine late bill and not a correction of an earlier invoice; earlier months' figures do not include them.",
  },
  unknown_branch: {
    title: "Rows with an unknown branch",
    sentence: () => "Rows whose Unite clinic is not mapped to a finance branch.",
    action:
      "Map the clinic name under Finance, Reference data (branches). The rows then count for that branch at once, no new upload needed.",
  },
  category_no: {
    title: 'Unmapped Unite category "NO"',
    sentence: () => 'Rows with an amount in Unite\'s service category literally named "NO".',
    action: "Ask the Unite administrator to give the item type its proper category.",
  },
  blank_visit_status: {
    title: "Blank visit status",
    sentence: () => "Rows Unite marks neither New, Revisit nor Follow-up.",
    action:
      "Ask the front desk to set the visit status in Unite; new-patient counts miss these rows.",
  },
  blank_invoice_type: {
    title: "Blank invoice type with billing",
    sentence: () => "Rows with net billing above 0 and no invoice type (self-pay or insurance).",
    action:
      "Ask billing to set the invoice type in Unite; the self-pay and insurance split cannot place these rows.",
  },
  cancelled: {
    title: "Cancelled rows",
    sentence: () =>
      "Rows Unite marks as cancelled. They stay in every total here, as in Unite's own totals.",
    action: "Check that each cancellation was intended and that any payment taken was refunded.",
  },
};

export type Signal = {
  key: SignalKey;
  title: string;
  sentence: string;
  action: string;
  rows: number;
  net: number;
};

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type DayRow = Sums & { date: string };
export type BranchRow = Sums & { branchCode: string | null };
export type DoctorRow = Sums & { doctorKey: string; name: string };
export type InvoiceTypeRow = Sums & { invoiceType: string | null };
export type BucketRow = Sums & { bucket: InvoiceBucket; label: string; types: string[] };
export type UnknownClinic = { clinic: string | null; rows: number; net: number };

export type CollectionsInputs = {
  month: string;
  branch: string | null;
  coverage: DateRange[];
  lateInvoiceDays: number;
  days: DayRow[];
  branches: BranchRow[];
  doctors: DoctorRow[];
  invoiceTypes: InvoiceTypeRow[];
  total: Sums;
  quality: Record<SignalKey, { rows: number; net: number }>;
  unknownClinics: UnknownClinic[];
};

export function parseCollectionsInputs(raw: unknown): CollectionsInputs {
  const r = obj(raw);
  const q = obj(r.quality);
  const days = Number(obj(r.settings).late_invoice_days);
  return {
    month: String(r.month ?? ""),
    branch: text(r.branch),
    coverage: arr(r.coverage)
      .map((x) => ({ from: String(x.from ?? ""), to: String(x.to ?? "") }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.from) && /^\d{4}-\d{2}-\d{2}$/.test(x.to)),
    lateInvoiceDays: Number.isInteger(days) && days >= 0 ? days : DEFAULT_LATE_INVOICE_DAYS,
    days: arr(r.days).map((x) => ({ ...sums(x), date: String(x.date ?? "") })),
    branches: arr(r.branches).map((x) => ({ ...sums(x), branchCode: text(x.branch_code) })),
    doctors: arr(r.doctors).map((x) => ({
      ...sums(x),
      doctorKey: String(x.doctor_key ?? ""),
      name: text(x.doctor_name) ?? String(x.doctor_key ?? ""),
    })),
    invoiceTypes: arr(r.invoice_types).map((x) => ({
      ...sums(x),
      invoiceType: text(x.invoice_type),
    })),
    total: sums(obj(r.total)),
    quality: Object.fromEntries(
      SIGNAL_KEYS.map((k) => {
        const s = obj(q[k]);
        return [k, { rows: n(s.rows), net: n(s.net) }];
      }),
    ) as Record<SignalKey, { rows: number; net: number }>,
    unknownClinics: arr(q.unknown_clinics).map((x) => ({
      clinic: text(x.clinic),
      rows: n(x.rows),
      net: n(x.net),
    })),
  };
}

const SUM_KEYS = [
  "rows",
  "cash",
  "card",
  "bankTransfer",
  "paymentGateway",
  "otherPayment",
  "collected",
  "patientShare",
  "insuranceClaim",
  "net",
  "advanceConsumed",
  "creditNoteConsumed",
  "outstandingCredit",
  "writeOff",
  "refund",
] as const satisfies readonly (keyof Sums)[];

const ZERO: Sums = Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) as Sums;

function addSums(a: Sums, b: Sums): Sums {
  return Object.fromEntries(
    SUM_KEYS.map((k) => [k, k === "rows" ? a.rows + b.rows : add(a[k], b[k])]),
  ) as Sums;
}

/** Self-pay vs insurance: the invoice-type rows grouped into the five buckets (empty buckets left out). */
export function invoiceBuckets(types: readonly InvoiceTypeRow[]): BucketRow[] {
  return INVOICE_BUCKETS.flatMap((bucket) => {
    const list = types.filter((t) => invoiceBucket(t.invoiceType) === bucket);
    if (list.length === 0) return [];
    return [
      {
        ...list.reduce<Sums>((acc, t) => addSums(acc, t), ZERO),
        bucket,
        label: INVOICE_BUCKET_LABEL[bucket],
        types: list.map((t) => t.invoiceType).filter((t): t is string => t !== null),
      },
    ];
  });
}

export type Reconciliation = {
  net: number;
  /** collected + insurance claim + patient share + outstanding credit + advance consumed + credit note consumed. */
  accountedFor: number;
  /** net − accountedFor; shown, never asserted to be 0. */
  difference: number;
};

export function reconciliationOf(t: Sums): Reconciliation {
  const accountedFor = add(
    t.collected,
    t.insuranceClaim,
    t.patientShare,
    t.outstandingCredit,
    t.advanceConsumed,
    t.creditNoteConsumed,
  );
  return { net: t.net, accountedFor, difference: add(t.net, -accountedFor) };
}

export type Collections = Omit<CollectionsInputs, "quality"> & {
  buckets: BucketRow[];
  signals: Signal[];
  reconciliation: Reconciliation;
  coverageInfo: Coverage;
  hasData: boolean;
};

const byNet = (a: DoctorRow, b: DoctorRow) =>
  b.net - a.net || b.collected - a.collected || a.name.localeCompare(b.name);

export function buildCollections(inputs: CollectionsInputs): Collections {
  const { quality, ...rest } = inputs;
  return {
    ...rest,
    doctors: [...inputs.doctors].sort(byNet),
    buckets: invoiceBuckets(inputs.invoiceTypes),
    signals: SIGNAL_KEYS.map((key) => ({
      key,
      title: SIGNAL_TEXT[key].title,
      sentence: SIGNAL_TEXT[key].sentence({ lateDays: inputs.lateInvoiceDays }),
      action: SIGNAL_TEXT[key].action,
      rows: quality[key].rows,
      net: quality[key].net,
    })),
    reconciliation: reconciliationOf(inputs.total),
    coverageInfo: coverageOf(inputs.month, inputs.coverage),
    hasData: inputs.total.rows > 0,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Same rule as the database check: a whole number of days from 0 to 60 (a blank is refused, never read as 0). */
export const dqSettingsSchema = z.object({
  dq_late_invoice_days: z
    .string({ message: "Give the late invoice days." })
    .trim()
    .regex(/^\d{1,2}$/, "Late invoice days: a whole number from 0 to 60.")
    .transform(Number)
    .refine((v) => v <= 60, "Late invoice days: at most 60."),
});
