/**
 * A naive, independent reference for fin_collections_inputs() (Phase 23D), written straight from the definitions in
 * docs/23_PHASE_23D_NOTES.md. Tests only: it checks the expected aggregates in the shared synthetic fixture and the SQL
 * function's branch scoping. Synthetic rows only.
 */

export type CollectionsFixtureRow = {
  upload: string;
  is_current: boolean;
  report_date: string;
  visit_at: string | null;
  invoice_date: string | null;
  clinic_name: string | null;
  branch_code: string | null;
  doctor_name: string;
  doctor_key: string;
  patient_pin: string | null;
  patient_ref: string | null;
  visit_status: string | null;
  invoice_type: string | null;
  selfpay_invoice_no: string | null;
  insurance_invoice_no: string | null;
  categories: Record<string, number>;
  is_cancelled: boolean;
  net: number;
  cash: number;
  card: number;
  bank_transfer: number;
  payment_gateway: number;
  other_payment: number;
  patient_share: number;
  insurance_claim: number;
  advance_consumed: number;
  credit_note_consumed: number;
  outstanding_credit: number;
  write_off: number;
  refund: number;
};

const AMOUNTS = [
  "cash",
  "card",
  "bank_transfer",
  "payment_gateway",
  "other_payment",
  "patient_share",
  "insurance_claim",
  "net",
  "advance_consumed",
  "credit_note_consumed",
  "outstanding_credit",
  "write_off",
  "refund",
] as const;

const r3 = (mils: number) => mils / 1000;
const m = (v: number) => Math.round(v * 1000);

function sums(rows: CollectionsFixtureRow[]): Record<string, number> {
  const out: Record<string, number> = { rows: rows.length };
  for (const k of AMOUNTS) out[k] = r3(rows.reduce((a, r) => a + m(r[k]), 0));
  return out;
}

/** "C" collation with nulls last, as the SQL sorts. */
const cmp = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

const groupBy = <T>(xs: T[], key: (x: T) => string | null) => {
  const map = new Map<string | null, T[]>();
  for (const x of xs) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
  return [...map.entries()].sort(([a], [b]) => cmp(a, b));
};

const dubaiDate = (iso: string) =>
  new Date(new Date(iso).getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const invoiceType = (t: string | null) => {
  const s = (t ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return s === "" ? null : s;
};
const blank = (s: string | null) => s === null || s.trim() === "";

export function referenceCollections(
  rows: CollectionsFixtureRow[],
  month: string,
  opts: {
    clinics: Record<string, string>;
    lateDays: number;
    branch?: string | null;
    branches?: string[] | null;
  },
) {
  const from = `${month.slice(0, 7)}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const to = end.toISOString().slice(0, 10);
  const branchOf = (r: CollectionsFixtureRow) =>
    (r.clinic_name !== null ? opts.clinics[r.clinic_name] : undefined) ?? r.branch_code;
  const v = rows
    .filter((r) => r.is_current && r.report_date >= from && r.report_date < to)
    .filter((r) => !opts.branches || opts.branches.includes(branchOf(r) ?? "\u0000"))
    .filter((r) => !opts.branch || branchOf(r) === opts.branch);

  const names = new Map<string, string>();
  for (const [key, list] of groupBy(v, (r) => r.doctor_key)) {
    const counted = groupBy(list, (r) => r.doctor_name)
      .map(([name, l]) => ({ name: name as string, n: l.length }))
      .sort((a, b) => b.n - a.n || cmp(a.name, b.name));
    names.set(key as string, counted[0].name);
  }

  const visitDate = (r: CollectionsFixtureRow) => (r.visit_at ? dubaiDate(r.visit_at) : null);
  const flag = {
    no_invoice: (r: CollectionsFixtureRow) =>
      blank(r.selfpay_invoice_no) && blank(r.insurance_invoice_no) && r.net === 0,
    late_invoice: (r: CollectionsFixtureRow) =>
      !!r.invoice_date && !!visitDate(r) && days(r.invoice_date, visitDate(r)!) > opts.lateDays,
    earlier_month: (r: CollectionsFixtureRow) =>
      !!r.invoice_date && !!visitDate(r) && visitDate(r)! < `${r.invoice_date.slice(0, 7)}-01`,
    unknown_branch: (r: CollectionsFixtureRow) => branchOf(r) === null,
    category_no: (r: CollectionsFixtureRow) => "NO" in r.categories,
    blank_visit_status: (r: CollectionsFixtureRow) => r.visit_status === null,
    blank_invoice_type: (r: CollectionsFixtureRow) =>
      invoiceType(r.invoice_type) === null && r.net > 0,
    cancelled: (r: CollectionsFixtureRow) => r.is_cancelled,
  };
  const quality: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(flag)) {
    const list = v.filter(f);
    quality[k] = { rows: list.length, net: r3(list.reduce((a, r) => a + m(r.net), 0)) };
  }
  quality.unknown_clinics = groupBy(
    v.filter((r) => branchOf(r) === null),
    (r) => (blank(r.clinic_name) ? null : r.clinic_name),
  ).map(([clinic, l]) => ({
    clinic,
    rows: l.length,
    net: r3(l.reduce((a, r) => a + m(r.net), 0)),
  }));

  return {
    days: groupBy(v, (r) => r.report_date).map(([date, l]) => ({ date, ...sums(l) })),
    branches: groupBy(v, (r) => branchOf(r)).map(([branch_code, l]) => ({
      branch_code,
      ...sums(l),
    })),
    doctors: groupBy(v, (r) => r.doctor_key).map(([doctor_key, l]) => ({
      doctor_key,
      doctor_name: names.get(doctor_key as string),
      ...sums(l),
    })),
    invoice_types: groupBy(v, (r) => invoiceType(r.invoice_type)).map(([invoice_type, l]) => ({
      invoice_type,
      ...sums(l),
    })),
    total: sums(v),
    quality,
  };
}
