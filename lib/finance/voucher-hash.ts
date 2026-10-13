import { createHash } from "node:crypto";

import type { PaymentMethod, SpecialCategory } from "@/lib/finance/vouchers";

/**
 * The voucher's content fingerprint (server and tests only: node:crypto). voucherCanonical() builds exactly the text
 * fin_voucher_canonical() builds in SQL (migration 20261024000100); a database test proves they agree. Approvals are bound
 * to the sha256 of this text: the voucher's fields, its linked supplier invoices (id and total) and the sha256 of every
 * attachment (its own and its invoices'). Text fields escape backslash, newline and carriage return; lists sort bytewise.
 */

export type VoucherContent = {
  id: string;
  orgId: string;
  voucherNo: string;
  voucherDate: string; // YYYY-MM-DD
  payeeName: string;
  supplierId: string | null;
  amount: number | string;
  currency: string;
  category: string;
  special: SpecialCategory;
  branchCode: string | null;
  costCentre: string | null;
  payFrom: string | null;
  paymentMethod: PaymentMethod;
  narration: string;
  invoices: ReadonlyArray<{ id: string; total: number | string }>;
  documentHashes: readonly string[];
};

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const amountText = (v: number | string) => Number(v).toFixed(2);
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The exact text fin_voucher_canonical() builds in SQL. */
export function voucherCanonical(c: VoucherContent): string {
  const invoices = c.invoices
    .map((i) => ({ id: i.id.toLowerCase(), total: amountText(i.total) }))
    .sort((a, b) => bytewise(a.id, b.id))
    .map((i) => `${i.id}=${i.total}`)
    .join(",");
  const docs = [...new Set(c.documentHashes.map((h) => h.toLowerCase()))].sort(bytewise).join(",");
  return [
    "pulse-voucher-v1",
    `id:${c.id.toLowerCase()}`,
    `org:${c.orgId.toLowerCase()}`,
    `number:${c.voucherNo}`,
    `date:${c.voucherDate}`,
    `payee:${esc(c.payeeName)}`,
    `supplier:${c.supplierId ? c.supplierId.toLowerCase() : "-"}`,
    `amount:${amountText(c.amount)}`,
    `currency:${c.currency}`,
    `category:${esc(c.category)}`,
    `special:${c.special}`,
    `branch:${c.branchCode === null ? "-" : esc(c.branchCode)}`,
    `cost_centre:${c.costCentre === null ? "-" : esc(c.costCentre)}`,
    `pay_from:${c.payFrom === null ? "-" : esc(c.payFrom)}`,
    `method:${c.paymentMethod}`,
    `narration:${esc(c.narration)}`,
    `invoices:${invoices}`,
    `documents:${docs}`,
  ].join("\n");
}

export function voucherContentHash(c: VoucherContent): string {
  return createHash("sha256").update(voucherCanonical(c), "utf8").digest("hex");
}
