import {
  INVOICE_FIELDS,
  LINE_FIELDS,
  PAYMENT_FIELDS,
  type FieldMap,
} from "@/lib/finance/unite-mapping";

/**
 * Retention: after a batch is processed and reconciled, remove personal data from the stored raw
 * payload but keep everything the mapper reads, so the batch can still be replayed.
 *
 * It is an ALLOWLIST: only keys the mapping knows (plus the response envelope and the item /
 * payment list keys) survive. Patient names, Emirates IDs, contacts and any field nobody has
 * mapped are dropped. `txn_ref_name` (possibly a cardholder name) is dropped too; a replay keeps the
 * value already stored (fin_apply_invoices coalesces it).
 */

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
const aliasSet = (fields: FieldMap, omit: readonly string[] = []) =>
  new Set(
    Object.entries(fields)
      .filter(([name]) => !omit.includes(name))
      .flatMap(([, spec]) => spec.aliases.map(squash)),
  );

const INVOICE_KEYS = aliasSet(INVOICE_FIELDS);
const LINE_KEYS = aliasSet(LINE_FIELDS);
const PAYMENT_KEYS = aliasSet(PAYMENT_FIELDS, ["txn_ref_name"]);
const ITEM_LIST_KEYS = new Set(["itemsdetails", "items", "itemdetails"].map(squash));
const PAYMENT_LIST_KEYS = new Set(["paymentdetails", "payments"].map(squash));
const ENVELOPE_KEYS = new Set(
  [
    "MessageStatus",
    "Status",
    "DetailMessage",
    "Message",
    "DataBalancetoSync",
    "OverallDataBalancetoSync",
  ].map(squash),
);

function pickKeys(obj: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).filter(([k]) => allowed.has(squash(k))),
  );
}

function stripInvoice(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  const out: Record<string, unknown> = pickKeys(rec, INVOICE_KEYS);
  for (const [key, value] of Object.entries(rec)) {
    const k = squash(key);
    if (ITEM_LIST_KEYS.has(k) && Array.isArray(value))
      out[key] = value.map((v) => pickKeys(v, LINE_KEYS));
    else if (PAYMENT_LIST_KEYS.has(k) && Array.isArray(value))
      out[key] = value.map((v) => pickKeys(v, PAYMENT_KEYS));
    else if (ITEM_LIST_KEYS.has(k) || PAYMENT_LIST_KEYS.has(k)) out[key] = value;
  }
  return out;
}

export function stripPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const rec = payload as Record<string, unknown>;
  const out: Record<string, unknown> = pickKeys(rec, ENVELOPE_KEYS);
  const dataKey = Object.keys(rec).find((k) => squash(k) === "data");
  if (dataKey !== undefined) {
    const data = rec[dataKey];
    out[dataKey] = Array.isArray(data) ? data.map(stripInvoice) : data;
  }
  return out;
}

export const RAW_PAYLOAD_RETENTION_DAYS = 90;
