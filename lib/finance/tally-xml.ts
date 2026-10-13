import { createHash } from "node:crypto";

/**
 * TallyPrime import file (pure; unit-tested). Written from TallyPrime's XML import documentation (the
 * ENVELOPE / HEADER / TALLYREQUEST "Import Data" request with REPORTNAME "Vouchers"); NOT yet verified against a real
 * Tally company (OQ-92). Althaf imports the file through Gateway of Tally > Import > Transactions. One-way: Pulse never
 * reads anything back from Tally.
 *
 *   Purchase (one per supplier invoice):  Dr expense ledger of the category (net, cost centre of the branch)
 *                                         Dr VAT input ledger (VAT, when there is any)
 *                                         Cr the supplier's ledger (total)
 *   Payment  (one per approved voucher):  Dr the supplier's ledger, or the category's expense ledger when the payee is not
 *                                            a supplier (with the branch cost centre)
 *                                         Cr the bank / cash ledger the voucher is paid from
 *
 * Tally's sign convention: a debit entry has ISDEEMEDPOSITIVE Yes and a negative AMOUNT, a credit entry ISDEEMEDPOSITIVE
 * No and a positive AMOUNT. Fails closed: when any ledger or cost centre is not mapped (fin_ref_tally_ledgers), nothing is
 * produced and the missing keys are listed. The same input always gives the same bytes (stable order, no timestamps).
 */

export type TallyLedgerKind = "supplier" | "category" | "bank" | "cost_centre" | "vat_input";

export const LEDGER_KIND_LABEL: Record<TallyLedgerKind, string> = {
  supplier: "Supplier",
  category: "Expense category",
  bank: "Bank / cash (pay from)",
  cost_centre: "Cost centre (branch)",
  vat_input: "VAT input",
};

export type TallyLedgerRow = { kind: TallyLedgerKind; key: string; ledger_name: string };

export type TallyPurchase = {
  id: string;
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  category: string;
  net: number;
  vat: number;
  branchCode: string | null;
};

export type TallyPayment = {
  id: string;
  voucherNo: string;
  /** The payment date when paid, otherwise the voucher date. */
  date: string;
  payeeName: string;
  supplierId: string | null;
  category: string;
  amount: number;
  branchCode: string | null;
  /** The bank / cash key; falls back to the payment method. */
  payFrom: string | null;
  paymentMethod: string;
  narration: string;
  paymentReference: string | null;
  invoiceNumbers: readonly string[];
  /** True when Pulse approved the voucher (route pulse); a Tally-route voucher is authorised in Tally. */
  approvedInPulse: boolean;
};

export type TallyMissing = { kind: TallyLedgerKind; key: string; label: string };

export type TallyBuildResult =
  | {
      ok: true;
      xml: string;
      checksum: string;
      purchaseCount: number;
      paymentCount: number;
      total: number;
    }
  | { ok: false; missing: TallyMissing[] };

/** XML 1.0 text: escape the five specials and drop characters XML cannot carry (control characters, lone surrogates). */
export function xmlEscape(value: string): string {
  return dropLoneSurrogates(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function dropLoneSurrogates(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += s[i];
  }
  return out;
}

const cents = (n: number) => Math.round(Number(n) * 100);
const amt = (c: number) => {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};
const tallyDate = (d: string) => d.slice(0, 10).replace(/-/g, "");
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

type Entry = { ledger: string; cents: number; debit: boolean; costCentre: string | null };

function ledgerEntry(e: Entry, costCategory: string, indent: string): string {
  const signed = e.debit ? -e.cents : e.cents;
  const lines = [
    `${indent}<ALLLEDGERENTRIES.LIST>`,
    `${indent}  <LEDGERNAME>${xmlEscape(e.ledger)}</LEDGERNAME>`,
    `${indent}  <ISDEEMEDPOSITIVE>${e.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `${indent}  <AMOUNT>${amt(signed)}</AMOUNT>`,
  ];
  if (e.costCentre) {
    lines.push(
      `${indent}  <CATEGORYALLOCATIONS.LIST>`,
      `${indent}    <CATEGORY>${xmlEscape(costCategory)}</CATEGORY>`,
      `${indent}    <ISDEEMEDPOSITIVE>${e.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
      `${indent}    <COSTCENTREALLOCATIONS.LIST>`,
      `${indent}      <NAME>${xmlEscape(e.costCentre)}</NAME>`,
      `${indent}      <AMOUNT>${amt(signed)}</AMOUNT>`,
      `${indent}    </COSTCENTREALLOCATIONS.LIST>`,
      `${indent}  </CATEGORYALLOCATIONS.LIST>`,
    );
  }
  lines.push(`${indent}</ALLLEDGERENTRIES.LIST>`);
  return lines.join("\n");
}

function voucherXml(v: {
  type: "Payment" | "Purchase";
  date: string;
  number: string;
  reference: string | null;
  party: string;
  narration: string;
  entries: Entry[];
  costCategory: string;
}): string {
  const debit = v.entries.filter((e) => e.debit).reduce((a, e) => a + e.cents, 0);
  const credit = v.entries.filter((e) => !e.debit).reduce((a, e) => a + e.cents, 0);
  if (debit !== credit) throw new Error(`unbalanced Tally voucher ${v.number}`);
  const i = "        ";
  return [
    '      <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `${i.slice(2)}<VOUCHER VCHTYPE="${v.type}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `${i}<DATE>${tallyDate(v.date)}</DATE>`,
    `${i}<VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>`,
    `${i}<VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>`,
    ...(v.reference ? [`${i}<REFERENCE>${xmlEscape(v.reference)}</REFERENCE>`] : []),
    `${i}<PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME>`,
    `${i}<NARRATION>${xmlEscape(v.narration)}</NARRATION>`,
    `${i}<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    ...v.entries.map((e) => ledgerEntry(e, v.costCategory, i)),
    `${i.slice(2)}</VOUCHER>`,
    "      </TALLYMESSAGE>",
  ].join("\n");
}

export function buildTallyXml(input: {
  company: string | null;
  costCategory: string;
  ledgers: readonly TallyLedgerRow[];
  purchases: readonly TallyPurchase[];
  payments: readonly TallyPayment[];
  /** Display names for supplier ids in the "missing" list. */
  supplierNames?: ReadonlyMap<string, string>;
}): TallyBuildResult {
  const map = new Map(input.ledgers.map((l) => [`${l.kind}|${l.key}`, l.ledger_name.trim()]));
  const missing = new Map<string, TallyMissing>();
  const need = (kind: TallyLedgerKind, key: string, label: string): string => {
    const hit = map.get(`${kind}|${key}`);
    if (hit) return hit;
    missing.set(`${kind}|${key}`, { kind, key, label });
    return "";
  };
  const supplierLabel = (id: string, fallback: string) => input.supplierNames?.get(id) ?? fallback;

  const purchases = [...input.purchases].sort(
    (a, b) =>
      bytewise(a.invoiceDate, b.invoiceDate) ||
      bytewise(a.supplierName, b.supplierName) ||
      bytewise(a.invoiceNumber, b.invoiceNumber) ||
      bytewise(a.id, b.id),
  );
  const payments = [...input.payments].sort(
    (a, b) =>
      bytewise(a.date, b.date) || bytewise(a.voucherNo, b.voucherNo) || bytewise(a.id, b.id),
  );

  const blocks: string[] = [];
  let total = 0;
  for (const p of purchases) {
    const supplier = need("supplier", p.supplierId, supplierLabel(p.supplierId, p.supplierName));
    const expense = need("category", p.category, p.category);
    const vatCents = cents(p.vat);
    const netCents = cents(p.net);
    const vatLedger = vatCents > 0 ? need("vat_input", "*", "VAT input") : "";
    const cc = p.branchCode ? need("cost_centre", p.branchCode, `Branch ${p.branchCode}`) : null;
    const entries: Entry[] = [
      { ledger: expense, cents: netCents, debit: true, costCentre: cc },
      ...(vatCents > 0
        ? [{ ledger: vatLedger, cents: vatCents, debit: true, costCentre: null }]
        : []),
      { ledger: supplier, cents: netCents + vatCents, debit: false, costCentre: null },
    ];
    total += netCents + vatCents;
    blocks.push(
      voucherXml({
        type: "Purchase",
        date: p.invoiceDate,
        number: clip(p.invoiceNumber, 60),
        reference: clip(p.invoiceNumber, 60),
        party: supplier,
        narration: clip(`Supplier invoice ${p.invoiceNumber} (Pulse)`, 200),
        entries,
        costCategory: input.costCategory,
      }),
    );
  }
  for (const v of payments) {
    const bankKey = v.payFrom ?? v.paymentMethod;
    const bank = need("bank", bankKey, `Pay from ${bankKey}`);
    const toSupplier = v.supplierId !== null;
    const debitLedger = toSupplier
      ? need("supplier", v.supplierId!, supplierLabel(v.supplierId!, v.payeeName))
      : need("category", v.category, v.category);
    const cc =
      !toSupplier && v.branchCode
        ? need("cost_centre", v.branchCode, `Branch ${v.branchCode}`)
        : null;
    const c = cents(v.amount);
    total += c;
    const refs = v.invoiceNumbers.length
      ? ` Invoices: ${[...v.invoiceNumbers].sort(bytewise).join(", ")}.`
      : "";
    const paid = v.paymentReference ? ` Bank ref ${v.paymentReference}.` : "";
    const approval = v.approvedInPulse ? "Approved in Pulse." : "To be authorised in Tally.";
    blocks.push(
      voucherXml({
        type: "Payment",
        date: v.date,
        number: v.voucherNo,
        reference: v.paymentReference ? clip(v.paymentReference, 60) : null,
        party: toSupplier ? debitLedger : bank,
        narration: clip(`${v.voucherNo}: ${v.narration}.${refs}${paid} ${approval}`, 400),
        entries: [
          { ledger: debitLedger, cents: c, debit: true, costCentre: cc },
          { ledger: bank, cents: c, debit: false, costCentre: null },
        ],
        costCategory: input.costCategory,
      }),
    );
  }

  if (missing.size > 0)
    return {
      ok: false,
      missing: [...missing.values()].sort(
        (a, b) => bytewise(a.kind, b.kind) || bytewise(a.key, b.key),
      ),
    };

  const company = input.company?.trim()
    ? [
        "        <STATICVARIABLES>",
        `          <SVCURRENTCOMPANY>${xmlEscape(input.company.trim())}</SVCURRENTCOMPANY>`,
        "        </STATICVARIABLES>",
      ]
    : [];
  const xml =
    [
      "<ENVELOPE>",
      "  <HEADER>",
      "    <TALLYREQUEST>Import Data</TALLYREQUEST>",
      "  </HEADER>",
      "  <BODY>",
      "    <IMPORTDATA>",
      "      <REQUESTDESC>",
      "        <REPORTNAME>Vouchers</REPORTNAME>",
      ...company,
      "      </REQUESTDESC>",
      "      <REQUESTDATA>",
      ...blocks,
      "      </REQUESTDATA>",
      "    </IMPORTDATA>",
      "  </BODY>",
      "</ENVELOPE>",
    ].join("\n") + "\n";
  return {
    ok: true,
    xml,
    checksum: createHash("sha256").update(xml, "utf8").digest("hex"),
    purchaseCount: purchases.length,
    paymentCount: payments.length,
    total: total / 100,
  };
}
