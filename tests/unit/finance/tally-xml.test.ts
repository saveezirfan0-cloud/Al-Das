import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildTallyXml,
  xmlEscape,
  type TallyLedgerRow,
  type TallyPayment,
  type TallyPurchase,
} from "@/lib/finance/tally-xml";

// Synthetic names and amounts only.
const SUP1 = "aaaaaaaa-0000-4000-8000-000000000001";
const SUP2 = "aaaaaaaa-0000-4000-8000-000000000002";

const LEDGERS: TallyLedgerRow[] = [
  { kind: "supplier", key: SUP1, ledger_name: "Supplier Test 01 (Creditor)" },
  { kind: "supplier", key: SUP2, ledger_name: "Supplier Test 02 & Sons" },
  { kind: "category", key: "Consumables", ledger_name: "Medical Consumables" },
  { kind: "category", key: "Utilities", ledger_name: "Electricity & Water" },
  { kind: "bank", key: "BANK-MAIN", ledger_name: "Bank Test Current A/c" },
  { kind: "bank", key: "cash", ledger_name: "Cash" },
  { kind: "cost_centre", key: "P", ledger_name: "Palm" },
  { kind: "vat_input", key: "*", ledger_name: "Input VAT 5%" },
];

const purchase: TallyPurchase = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  supplierId: SUP1,
  supplierName: "Supplier Test 01",
  invoiceNumber: "INV-<77>",
  invoiceDate: "2026-10-03",
  category: "Consumables",
  net: 1000,
  vat: 50,
  branchCode: "P",
};

const toSupplier: TallyPayment = {
  id: "cccccccc-0000-4000-8000-000000000001",
  voucherNo: "PV-2026-0002",
  date: "2026-10-08",
  payeeName: "Supplier Test 01",
  supplierId: SUP1,
  category: "Consumables",
  amount: 1050,
  branchCode: "P",
  payFrom: "BANK-MAIN",
  paymentMethod: "bank_transfer",
  narration: 'Gloves "and" masks',
  paymentReference: "BANKREF-0001",
  invoiceNumbers: ["INV-<77>"],
};

const expense: TallyPayment = {
  id: "cccccccc-0000-4000-8000-000000000002",
  voucherNo: "PV-2026-0001",
  date: "2026-10-05",
  payeeName: "Utility Test",
  supplierId: null,
  category: "Utilities",
  amount: 812.4,
  branchCode: "P",
  payFrom: null,
  paymentMethod: "cash",
  narration: "October bill",
  paymentReference: null,
  invoiceNumbers: [],
};

const build = (over: Partial<Parameters<typeof buildTallyXml>[0]> = {}) =>
  buildTallyXml({
    company: "Clinic Test LLC",
    costCategory: "Primary Cost Category",
    ledgers: LEDGERS,
    purchases: [purchase],
    payments: [toSupplier, expense],
    ...over,
  });

describe("TallyPrime import XML", () => {
  it("wraps vouchers in the documented import envelope", () => {
    const r = build();
    if (!r.ok) throw new Error("expected ok");
    expect(
      r.xml.startsWith("<ENVELOPE>\n  <HEADER>\n    <TALLYREQUEST>Import Data</TALLYREQUEST>"),
    ).toBe(true);
    expect(r.xml).toContain("<IMPORTDATA>");
    expect(r.xml).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(r.xml).toContain("<SVCURRENTCOMPANY>Clinic Test LLC</SVCURRENTCOMPANY>");
    expect(r.xml.match(/<TALLYMESSAGE xmlns:UDF="TallyUDF">/g)).toHaveLength(3);
    expect(r.xml.trimEnd().endsWith("</ENVELOPE>")).toBe(true);
    expect(r).toMatchObject({ purchaseCount: 1, paymentCount: 2, total: 1050 + 1050 + 812.4 });
  });

  it("orders purchases first, then payments by date, and uses yyyymmdd dates", () => {
    const r = build();
    if (!r.ok) throw new Error("expected ok");
    const types = [...r.xml.matchAll(/VCHTYPE="(\w+)"/g)].map((m) => m[1]);
    expect(types).toEqual(["Purchase", "Payment", "Payment"]);
    const dates = [...r.xml.matchAll(/<DATE>(\d+)<\/DATE>/g)].map((m) => m[1]);
    expect(dates).toEqual(["20261003", "20261005", "20261008"]);
  });

  it("debits are ISDEEMEDPOSITIVE Yes with a negative amount, credits No with a positive amount, and each voucher balances", () => {
    const r = build();
    if (!r.ok) throw new Error("expected ok");
    const purchaseXml = r.xml.slice(
      r.xml.indexOf('VCHTYPE="Purchase"'),
      r.xml.indexOf('VCHTYPE="Payment"'),
    );
    const entries = [
      ...purchaseXml.matchAll(
        /<LEDGERNAME>(.*?)<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g,
      ),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(entries).toEqual([
      ["Medical Consumables", "Yes", "-1000.00"],
      ["Input VAT 5%", "Yes", "-50.00"],
      ["Supplier Test 01 (Creditor)", "No", "1050.00"],
    ]);
    // every voucher: the ledger amounts sum to zero
    for (const block of r.xml.split("<VOUCHER ").slice(1)) {
      const sum = [
        ...block.matchAll(
          /<ALLLEDGERENTRIES.LIST>\s*<LEDGERNAME>.*?<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>\w+<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g,
        ),
      ]
        .map((m) => Math.round(Number(m[1]) * 100))
        .reduce((a, b) => a + b, 0);
      expect(sum).toBe(0);
    }
  });

  it("allocates the branch cost centre on expense debits, and pays a supplier from the bank", () => {
    const r = build();
    if (!r.ok) throw new Error("expected ok");
    expect(r.xml).toContain("<CATEGORY>Primary Cost Category</CATEGORY>");
    expect(r.xml.match(/<COSTCENTREALLOCATIONS.LIST>/g)).toHaveLength(2); // purchase expense + direct expense payment
    expect(r.xml).toContain("<NAME>Palm</NAME>");
    const pay = r.xml.slice(r.xml.indexOf("PV-2026-0002") - 300);
    expect(pay).toContain("<PARTYLEDGERNAME>Supplier Test 01 (Creditor)</PARTYLEDGERNAME>");
    expect(pay).toContain("<REFERENCE>BANKREF-0001</REFERENCE>");
    // a cash expense falls back to the payment method as the pay-from key
    expect(r.xml).toContain("<LEDGERNAME>Cash</LEDGERNAME>");
  });

  it("escapes XML strictly and drops characters XML cannot carry", () => {
    expect(xmlEscape(`a & b < c > d "e" 'f'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;",
    );
    expect(xmlEscape("line1\nline2\u0000\u0007\uD800x")).toBe("line1 line2x");
    expect(xmlEscape("emoji 😀 stays")).toBe("emoji 😀 stays");
    const r = build();
    if (!r.ok) throw new Error("expected ok");
    expect(r.xml).toContain("<VOUCHERNUMBER>INV-&lt;77&gt;</VOUCHERNUMBER>");
    expect(r.xml).not.toContain("Supplier Test 02"); // an unused ledger is not emitted
    expect(r.xml).toContain("Gloves &quot;and&quot; masks");
  });

  it("is deterministic and checksummed (input order does not matter)", () => {
    const a = build();
    const b = build({ payments: [expense, toSupplier], ledgers: [...LEDGERS].reverse() });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(b.xml).toBe(a.xml);
    expect(a.checksum).toBe(createHash("sha256").update(a.xml, "utf8").digest("hex"));
  });

  it("refuses, listing every missing ledger, when anything is unmapped", () => {
    const r = build({
      ledgers: LEDGERS.filter(
        (l) =>
          !(
            l.kind === "vat_input" ||
            (l.kind === "bank" && l.key === "cash") ||
            l.kind === "cost_centre"
          ),
      ),
      supplierNames: new Map([[SUP1, "Supplier Test 01"]]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.map((m) => `${m.kind}:${m.key}`)).toEqual([
      "bank:cash",
      "cost_centre:P",
      "vat_input:*",
    ]);
    const noSupplier = build({ ledgers: LEDGERS.filter((l) => l.kind !== "supplier") });
    expect(noSupplier.ok).toBe(false);
    if (!noSupplier.ok) expect(noSupplier.missing.every((m) => m.kind === "supplier")).toBe(true);
  });

  it("leaves out the company when none is set, and the VAT line when there is no VAT", () => {
    const r = build({ company: null, purchases: [{ ...purchase, vat: 0 }], payments: [] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.xml).not.toContain("SVCURRENTCOMPANY");
    expect(r.xml).not.toContain("Input VAT");
  });
});
