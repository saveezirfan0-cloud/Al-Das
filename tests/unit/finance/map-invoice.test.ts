import { describe, expect, it } from "vitest";

import { mapBatch, mapInvoice, MappingError } from "@/lib/finance/map-invoice";

import { rawInvoice, rawLine, rawPayment } from "./factory";

describe("mapInvoice", () => {
  it("maps a plain invoice", () => {
    const inv = mapInvoice(rawInvoice());
    expect(inv).toMatchObject({
      inv_display_number: "ADMC/C/90001",
      transaction_date: "2026-03-02",
      patient_pin: "PIN-TEST-1",
      appointment_id: "APPT-TEST-1",
      unite_clinic_long_name: "Test Clinic One",
      doctor_dha_id: "DHA-TEST-1",
      inv_type: "SELF PAID",
      is_deleted: false,
      is_package: false,
      gross: 100,
      net: 100,
      total: 100,
    });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({
      line_key: "ADMC/C/90001|T-TEST-1|1",
      position: 1,
      line_net: 100,
      qty: 1,
    });
    expect(inv.payments[0]).toMatchObject({
      payment_key: "ADMC/C/90001|1|R-TEST-1",
      paid: 100,
      paid_date: "2026-03-02",
    });
  });

  it("treats an empty AppointmentId as null (direct invoice)", () => {
    expect(mapInvoice(rawInvoice({ AppointmentId: "" })).appointment_id).toBeNull();
  });

  it("matches field names case- and separator-insensitively", () => {
    const inv = mapInvoice(
      rawInvoice({ InvDisplayNumber: undefined, inv_display_number: "ADMC/1" }),
    );
    expect(inv.inv_display_number).toBe("ADMC/1");
  });

  it("parses the supported date formats and rejects impossible dates", () => {
    expect(
      mapInvoice(rawInvoice({ TransactionDate: "2026-03-02T10:15:00Z" })).transaction_date,
    ).toBe("2026-03-02");
    expect(mapInvoice(rawInvoice({ TransactionDate: "02/03/2026" })).transaction_date).toBe(
      "2026-03-02",
    );
    expect(() => mapInvoice(rawInvoice({ TransactionDate: "31-02-2026" }))).toThrow(MappingError);
    expect(() => mapInvoice(rawInvoice({ TransactionDate: "March 2" }))).toThrow(/unparseable/);
  });

  it("numbers repeated item codes and keeps line order", () => {
    const inv = mapInvoice(
      rawInvoice({ ItemsDetails: [rawLine(), rawLine({ ItemCode: "T-TEST-2" }), rawLine()] }),
    );
    expect(inv.lines.map((l) => l.line_key)).toEqual([
      "ADMC/C/90001|T-TEST-1|1",
      "ADMC/C/90001|T-TEST-2|1",
      "ADMC/C/90001|T-TEST-1|2",
    ]);
    expect(inv.lines.map((l) => l.position)).toEqual([1, 2, 3]);
  });

  it("keeps each payment instalment distinct and disambiguates identical keys", () => {
    const inv = mapInvoice(
      rawInvoice({
        PaymentDetails: [
          rawPayment(),
          rawPayment({ InstalmentNo: 2, ReceiptNumber: "R-TEST-2", Paid: "50" }),
          rawPayment({ InstalmentNo: "", ReceiptNumber: "", Paid: "10" }),
          rawPayment({ InstalmentNo: "", ReceiptNumber: "", Paid: "20" }),
        ],
      }),
    );
    expect(inv.payments.map((p) => p.payment_key)).toEqual([
      "ADMC/C/90001|1|R-TEST-1",
      "ADMC/C/90001|2|R-TEST-2",
      "ADMC/C/90001||",
      "ADMC/C/90001||#2",
    ]);
  });

  it("captures refunds, deletion and package flags", () => {
    const inv = mapInvoice(
      rawInvoice({
        IsDeleted: "Y",
        IsPackage: true,
        PaymentDetails: [rawPayment({ Refund: "25.50", RefundDate: "05-03-2026" })],
      }),
    );
    expect(inv.is_deleted).toBe(true);
    expect(inv.is_package).toBe(true);
    expect(inv.payments[0]).toMatchObject({ refund: 25.5, refund_date: "2026-03-05" });
  });

  it("changes the hash when business content changes, not when key order does", () => {
    const base = mapInvoice(rawInvoice());
    const reordered = mapInvoice(Object.fromEntries(Object.entries(rawInvoice()).reverse()));
    expect(reordered.record_hash).toBe(base.record_hash);
    expect(mapInvoice(rawInvoice({ NetAmount: "90.00" })).record_hash).not.toBe(base.record_hash);
    expect(mapInvoice(rawInvoice({ IsDeleted: "Y" })).record_hash).not.toBe(base.record_hash);
    expect(
      mapInvoice(
        rawInvoice({
          PaymentDetails: [rawPayment(), rawPayment({ InstalmentNo: 2, ReceiptNumber: "R-2" })],
        }),
      ).record_hash,
    ).not.toBe(base.record_hash);
  });

  it("never lets patient names or ids into the history snapshot", () => {
    const inv = mapInvoice(
      rawInvoice({ PaymentDetails: [rawPayment({ TxnRefName: "Test Cardholder" })] }),
    );
    const snapshot = JSON.stringify(inv.record);
    expect(snapshot).not.toContain("Test Patient One");
    expect(snapshot).not.toContain("000-0000");
    expect(snapshot).not.toContain("Test Cardholder");
    expect(inv.payments[0].txn_ref_name).toBe("Test Cardholder"); // still on the payment row
  });

  describe("fails closed", () => {
    it.each([
      ["net missing", { NetAmount: undefined }, /net is missing/],
      ["net blank", { NetAmount: "  " }, /net is blank/],
      ["total unparseable", { TotalAmount: "abc" }, /total has an unparseable/],
      ["IsDeleted missing", { IsDeleted: undefined }, /is_deleted is missing/],
      ["IsDeleted unrecognised", { IsDeleted: "maybe" }, /is_deleted has an unparseable/],
      ["date blank", { TransactionDate: "" }, /transaction_date is blank/],
    ])("%s", (_name, over, message) => {
      expect(() => mapInvoice(rawInvoice(over))).toThrow(message);
    });

    it("never turns a blank amount into zero", () => {
      const inv = mapInvoice(rawInvoice({ DiscountAmount: "", VATAmount: null }));
      expect(inv.discount).toBeNull();
      expect(inv.vat).toBeNull();
    });

    it("rejects lines without a code or net amount, and unrecognisable payments", () => {
      expect(() => mapInvoice(rawInvoice({ ItemsDetails: [rawLine({ ItemCode: "" })] }))).toThrow(
        /line 1.item_code is blank/,
      );
      expect(() =>
        mapInvoice(rawInvoice({ ItemsDetails: [rawLine({ NetAmount: undefined })] })),
      ).toThrow(/line 1.line_net is missing/);
      expect(() => mapInvoice(rawInvoice({ PaymentDetails: [{ Foo: "bar" }] }))).toThrow(
        /no recognisable paid/,
      );
    });

    it("requires the item and payment lists to be present lists", () => {
      expect(() => mapInvoice(rawInvoice({ ItemsDetails: undefined }))).toThrow(
        /ItemsDetails is missing/,
      );
      expect(() => mapInvoice(rawInvoice({ PaymentDetails: "x" }))).toThrow(
        /PaymentDetails is not a list/,
      );
    });

    it("names the invoice and field but never the value", () => {
      try {
        mapInvoice(rawInvoice({ TotalAmount: "SECRET-VALUE-123" }));
        throw new Error("expected a failure");
      } catch (err) {
        expect(err).toBeInstanceOf(MappingError);
        expect((err as Error).message).toContain("ADMC/C/90001");
        expect((err as Error).message).not.toContain("SECRET-VALUE-123");
      }
    });
  });
});

describe("mapBatch", () => {
  it("maps every record and rejects a repeated invoice number", () => {
    expect(mapBatch([rawInvoice(), rawInvoice({ InvDisplayNumber: "ADMC/90002" })])).toHaveLength(
      2,
    );
    expect(() => mapBatch([rawInvoice(), rawInvoice()])).toThrow(/appears twice/);
  });
});
