import { describe, expect, it } from "vitest";

import {
  buildCollections,
  dqSettingsSchema,
  invoiceBucket,
  invoiceBuckets,
  parseCollectionsInputs,
  reconciliationOf,
  SIGNAL_KEYS,
} from "@/lib/finance/collections";

import fixture from "./fixtures/phase23-collections.synthetic.json";

const SQL_OUTPUT = {
  month: "2026-09-01",
  branch: null,
  coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
  settings: { late_invoice_days: 3 },
  ...fixture.expected,
};

describe("invoice type buckets", () => {
  it("places Unite's invoice types in a closed list, never guessing", () => {
    expect(invoiceBucket("SELF PAID")).toBe("self_pay");
    expect(invoiceBucket(" self  paid ")).toBe("self_pay");
    expect(invoiceBucket("INSURANCE")).toBe("insurance");
    expect(invoiceBucket("INSURANCE, SELF PAID")).toBe("both");
    expect(invoiceBucket("SELF PAID,INSURANCE")).toBe("both");
    expect(invoiceBucket("INSURANCE, INSURANCE")).toBe("insurance");
    expect(invoiceBucket(null)).toBe("blank");
    expect(invoiceBucket("   ")).toBe("blank");
    expect(invoiceBucket(",")).toBe("blank");
    expect(invoiceBucket("CORPORATE")).toBe("other");
    expect(invoiceBucket("SELF PAY")).toBe("other");
    expect(invoiceBucket("INSURANCE, CORPORATE")).toBe("other");
  });

  it("adds the invoice-type rows of a bucket together, in thousandths", () => {
    const zero = {
      rows: 0,
      cash: 0,
      card: 0,
      bankTransfer: 0,
      paymentGateway: 0,
      otherPayment: 0,
      collected: 0,
      patientShare: 0,
      insuranceClaim: 0,
      net: 0,
      advanceConsumed: 0,
      creditNoteConsumed: 0,
      outstandingCredit: 0,
      writeOff: 0,
      refund: 0,
    };
    const buckets = invoiceBuckets([
      { ...zero, invoiceType: "SELF PAID", rows: 2, net: 0.1, collected: 0.1 },
      { ...zero, invoiceType: "INSURANCE", rows: 1, net: 5 },
      { ...zero, invoiceType: "SELF PAID ", rows: 1, net: 0.2, collected: 0.2 },
      { ...zero, invoiceType: "CASH", rows: 1, net: 7 },
    ]);
    expect(buckets.map((b) => [b.bucket, b.rows, b.net, b.collected, b.types])).toEqual([
      ["self_pay", 3, 0.3, 0.3, ["SELF PAID", "SELF PAID "]],
      ["insurance", 1, 5, 0, ["INSURANCE"]],
      ["other", 1, 7, 0, ["CASH"]],
    ]);
  });
});

describe("collections report", () => {
  const r = buildCollections(parseCollectionsInputs(SQL_OUTPUT));

  it("totals collected as the five payment columns", () => {
    expect(r.total.collected).toBe(1940.555);
    for (const d of [...r.days, ...r.branches, ...r.doctors])
      expect(d.collected).toBeCloseTo(
        d.cash + d.card + d.bankTransfer + d.paymentGateway + d.otherPayment,
        6,
      );
    const sum = (k: "net" | "collected") =>
      Math.round(r.days.reduce((a, d) => a + d[k] * 1000, 0)) / 1000;
    expect(sum("net")).toBe(r.total.net);
    expect(sum("collected")).toBe(r.total.collected);
  });

  it("shows the reconciliation difference and never forces it to 0", () => {
    expect(r.reconciliation).toEqual({ net: 3700.555, accountedFor: 3990.555, difference: -290 });
    const t = { ...r.total, net: 100, collected: 60, insuranceClaim: 40 };
    expect(
      reconciliationOf({
        ...t,
        patientShare: 0,
        outstandingCredit: 0,
        advanceConsumed: 0,
        creditNoteConsumed: 0,
      }),
    ).toEqual({ net: 100, accountedFor: 100, difference: 0 });
  });

  it("lists every signal with its fixed sentence, count and net", () => {
    expect(r.signals.map((s) => s.key)).toEqual(SIGNAL_KEYS);
    const late = r.signals.find((s) => s.key === "late_invoice")!;
    expect(late).toMatchObject({ rows: 2, net: 380 });
    expect(late.sentence).toBe("Invoices raised more than 3 days after the visit.");
    expect(
      buildCollections(
        parseCollectionsInputs({ ...SQL_OUTPUT, settings: { late_invoice_days: 1 } }),
      ).signals.find((s) => s.key === "late_invoice")!.sentence,
    ).toBe("Invoices raised more than 1 day after the visit.");
    for (const s of r.signals) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.action.length).toBeGreaterThan(0);
    }
    expect(r.unknownClinics).toEqual([
      { clinic: "Synthetic Clinic Unmapped", rows: 1, net: 250 },
      { clinic: null, rows: 1, net: 40 },
    ]);
  });

  it("orders doctors by net billing and keeps branch codes, unknown as null", () => {
    expect(r.doctors.map((d) => d.name)).toEqual([
      "Dr Demo-01",
      "Dr Demo-02",
      "Dr Demo-03",
      "Dr Demo-04",
    ]);
    expect(r.branches.map((b) => b.branchCode)).toEqual(["GM", "PJ", null]);
    expect(r.hasData).toBe(true);
    expect(r.coverageInfo).toMatchObject({ full: true, label: "1–30 Sep 2026" });
  });

  it("parses an empty or odd payload to zeros, with the default late days", () => {
    const e = buildCollections(parseCollectionsInputs({ month: "2026-01-01" }));
    expect(e.hasData).toBe(false);
    expect(e.total.collected).toBe(0);
    expect(e.lateInvoiceDays).toBe(3);
    expect(e.signals.every((s) => s.rows === 0 && s.net === 0)).toBe(true);
    expect(e.coverageInfo.full).toBe(false);
    expect(parseCollectionsInputs({ settings: { late_invoice_days: -2 } }).lateInvoiceDays).toBe(3);
    expect(parseCollectionsInputs({ settings: { late_invoice_days: 0 } }).lateInvoiceDays).toBe(0);
  });
});

describe("late invoice setting", () => {
  it("takes a whole number of days from 0 to 60 and refuses a blank", () => {
    expect(dqSettingsSchema.parse({ dq_late_invoice_days: " 7 " })).toEqual({
      dq_late_invoice_days: 7,
    });
    expect(dqSettingsSchema.parse({ dq_late_invoice_days: "0" }).dq_late_invoice_days).toBe(0);
    expect(dqSettingsSchema.parse({ dq_late_invoice_days: "60" }).dq_late_invoice_days).toBe(60);
    for (const bad of ["", "61", "-1", "2.5", "abc", "100"])
      expect(dqSettingsSchema.safeParse({ dq_late_invoice_days: bad }).success, bad).toBe(false);
    expect(dqSettingsSchema.safeParse({}).success).toBe(false);
  });
});
