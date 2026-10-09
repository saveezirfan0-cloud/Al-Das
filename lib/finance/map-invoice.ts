import { createHash } from "node:crypto";

import { lineKeys, paymentKey } from "@/lib/finance/keys";
import {
  INVOICE_FIELDS,
  LINE_FIELDS,
  PAYMENT_ANCHORS,
  PAYMENT_FIELDS,
  pick,
  type FieldMap,
} from "@/lib/finance/unite-mapping";

/**
 * Pure mapping from one raw Unite invoice to the normalised shape that
 * fin_apply_invoices writes. Fails closed: required fields that are missing,
 * blank or unparseable throw a MappingError (naming the invoice and field,
 * never the value) so the batch is marked failed and can be replayed after the
 * mapping is fixed. Blank never becomes 0 or false.
 */

export class MappingError extends Error {
  constructor(
    readonly invoice: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`invoice ${invoice}: ${field} ${reason}`);
    this.name = "MappingError";
  }
}

export type NormalizedLine = {
  line_key: string;
  position: number;
  item_code: string;
  cpt_code: string | null;
  item_short_desc: string | null;
  item_type: string | null;
  qty: number | null;
  line_price: number | null;
  line_gross: number | null;
  line_discount: number | null;
  line_net: number;
  vat_applicable: boolean | null;
  vat: number | null;
  total: number | null;
  line_remarks: string | null;
  is_package_item: boolean;
  actual_cost_price: number | null;
};

export type NormalizedPayment = {
  payment_key: string;
  instalment: string | null;
  payment_mode: string | null;
  collected: number | null;
  paid: number | null;
  paid_date: string | null;
  returned: number | null;
  receipt_number: string | null;
  advance_added: number | null;
  refund: number | null;
  refund_date: string | null;
  txn_ref_no: string | null;
  txn_ref_name: string | null;
  card_type: string | null;
  surcharge: number | null;
  remarks: string | null;
};

export type NormalizedInvoice = {
  inv_display_number: string;
  ref_type: string | null;
  transaction_date: string;
  patient_pin: string | null;
  appointment_id: string | null;
  unite_clinic_long_name: string | null;
  unite_bu_short_name: string | null;
  doctor_dha_id: string | null;
  doctor_name: string | null;
  department: string | null;
  specialty: string | null;
  inv_type: string | null;
  is_package: boolean;
  is_deleted: boolean;
  gross: number;
  discount: number | null;
  net: number;
  vat_applicable: boolean | null;
  vat: number | null;
  total: number;
  write_off: number | null;
  credit_note: number | null;
  referral_doctor: string | null;
  referral_doctor_id: string | null;
  referral_clinic: string | null;
  referral_clinic_id: string | null;
  created_by: string | null;
  modified_by: string | null;
  lines: NormalizedLine[];
  payments: NormalizedPayment[];
  /** sha256 over the business content; version bumps only when it changes. */
  record_hash: string;
  /** Snapshot stored in fin_invoice_versions: normalised fields only, no patient names, no txn_ref_name. */
  record: Record<string, unknown>;
};

// ---- scalar parsers ---------------------------------------------------------

const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function str(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function num(v: unknown): number | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : "invalid";
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return "invalid";
    return Number(cleaned);
  }
  return "invalid";
}

function bool(v: unknown): boolean | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : "invalid";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return "invalid";
}

/** dd-MM-yyyy, dd/MM/yyyy, yyyy-MM-dd (optionally followed by a time) -> yyyy-MM-dd. */
function date(v: unknown): string | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v !== "string") return "invalid";
  const s = v.trim();
  let y: string, m: string, d: string;
  let match = /^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T].*)?$/.exec(s);
  if (match) [, d, m, y] = match;
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s))) [, y, m, d] = match;
  else return "invalid";
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(m) - 1 ||
    dt.getUTCDate() !== Number(d)
  )
    return "invalid";
  return `${y}-${m}-${d}`;
}

type Kind = "string" | "number" | "boolean" | "date";
const KINDS: Record<string, Kind> = {
  transaction_date: "date",
  paid_date: "date",
  refund_date: "date",
  is_package: "boolean",
  is_deleted: "boolean",
  vat_applicable: "boolean",
  is_package_item: "boolean",
  gross: "number",
  discount: "number",
  net: "number",
  vat: "number",
  total: "number",
  write_off: "number",
  credit_note: "number",
  qty: "number",
  line_price: "number",
  line_gross: "number",
  line_discount: "number",
  line_net: "number",
  actual_cost_price: "number",
  collected: "number",
  paid: "number",
  returned: "number",
  advance_added: "number",
  refund: "number",
  surcharge: "number",
};

function resolve(
  invoice: string,
  raw: Record<string, unknown>,
  fields: FieldMap,
  scope: string,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const label = scope ? `${scope}.${name}` : name;
    const { found, value } = pick(raw, spec.aliases);
    if (!found && spec.required) throw new MappingError(invoice, label, "is missing");
    const kind = KINDS[name] ?? "string";
    const parsed =
      kind === "number"
        ? num(value)
        : kind === "boolean"
          ? bool(value)
          : kind === "date"
            ? date(value)
            : str(value);
    if (parsed === "invalid")
      throw new MappingError(invoice, label, `has an unparseable ${kind} value`);
    if (parsed === null && spec.required) throw new MappingError(invoice, label, "is blank");
    out[name] = parsed;
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function mapInvoice(raw: unknown, index = 0): NormalizedInvoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new MappingError(`#${index + 1}`, "record", "is not an object");
  const rec = raw as Record<string, unknown>;

  const idProbe = pick(rec, INVOICE_FIELDS.inv_display_number.aliases);
  const label = str(idProbe.value) ?? `#${index + 1}`;
  const f = resolve(label, rec, INVOICE_FIELDS, "");
  const invNo = f.inv_display_number as string;

  const itemsRaw = pick(rec, ["ItemsDetails", "Items", "ItemDetails"]);
  const paymentsRaw = pick(rec, ["PaymentDetails", "Payments"]);
  if (!itemsRaw.found) throw new MappingError(invNo, "ItemsDetails", "is missing");
  if (!paymentsRaw.found) throw new MappingError(invNo, "PaymentDetails", "is missing");
  const itemsArr = itemsRaw.value ?? [];
  const paymentsArr = paymentsRaw.value ?? [];
  if (!Array.isArray(itemsArr)) throw new MappingError(invNo, "ItemsDetails", "is not a list");
  if (!Array.isArray(paymentsArr)) throw new MappingError(invNo, "PaymentDetails", "is not a list");

  const lineRows = itemsArr.map((it, i) => {
    if (!it || typeof it !== "object")
      throw new MappingError(invNo, `line ${i + 1}`, "is not an object");
    return resolve(invNo, it as Record<string, unknown>, LINE_FIELDS, `line ${i + 1}`);
  });
  const keys = lineKeys(
    invNo,
    lineRows.map((l) => l.item_code as string),
  );
  const lines: NormalizedLine[] = lineRows.map((l, i) => ({
    ...(l as Omit<NormalizedLine, "line_key" | "position" | "is_package_item">),
    is_package_item: (l.is_package_item as boolean | null) ?? false,
    line_key: keys[i],
    position: i + 1,
  }));

  const payments: NormalizedPayment[] = paymentsArr.map((p, i) => {
    if (!p || typeof p !== "object")
      throw new MappingError(invNo, `payment ${i + 1}`, "is not an object");
    const r = resolve(invNo, p as Record<string, unknown>, PAYMENT_FIELDS, `payment ${i + 1}`);
    if (PAYMENT_ANCHORS.every((a) => r[a] === null))
      throw new MappingError(
        invNo,
        `payment ${i + 1}`,
        "has no recognisable paid, collected or refund amount",
      );
    return {
      ...(r as Omit<NormalizedPayment, "payment_key">),
      payment_key: paymentKey(
        invNo,
        r.instalment as string | null,
        r.receipt_number as string | null,
      ),
    };
  });
  // Two payments can share instalment + receipt (both blank is common): number repeats in delivery order.
  const seenKeys = new Map<string, number>();
  for (const p of payments) {
    const n = (seenKeys.get(p.payment_key) ?? 0) + 1;
    seenKeys.set(p.payment_key, n);
    if (n > 1) p.payment_key = `${p.payment_key}#${n}`;
  }

  const body = {
    ...(f as Omit<NormalizedInvoice, "lines" | "payments" | "record_hash" | "record">),
    is_package: (f.is_package as boolean | null) ?? false,
    is_deleted: f.is_deleted as boolean,
  } as Omit<NormalizedInvoice, "lines" | "payments" | "record_hash" | "record">;

  // txn_ref_name may hold a cardholder name: kept for the business row, never in the history snapshot or the hash.
  const snapshotPayments = payments.map((p) => {
    const { txn_ref_name, ...rest } = p;
    void txn_ref_name;
    return rest;
  });
  const record = { ...body, lines, payments: snapshotPayments };
  const record_hash = createHash("sha256").update(stableStringify(record)).digest("hex");

  return { ...body, lines, payments, record_hash, record };
}

export function mapBatch(data: readonly unknown[]): NormalizedInvoice[] {
  const seen = new Set<string>();
  return data.map((d, i) => {
    const inv = mapInvoice(d, i);
    if (seen.has(inv.inv_display_number))
      throw new MappingError(
        inv.inv_display_number,
        "inv_display_number",
        "appears twice in one batch",
      );
    seen.add(inv.inv_display_number);
    return inv;
  });
}
