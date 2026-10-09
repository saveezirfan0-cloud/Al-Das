import { describe, expect, it } from "vitest";

import { mapBatch } from "@/lib/finance/map-invoice";
import { runMaintenance } from "@/lib/finance/maintenance";
import { stripPayload } from "@/lib/finance/strip-payload";

import { rawInvoice, rawLine, rawPayment } from "./factory";

const payload = () => ({
  MessageStatus: "Success",
  DetailMessage: "ok",
  DataBalancetoSync: 3,
  OverallDataBalancetoSync: 9,
  SomethingElse: "drop me",
  Data: [
    rawInvoice({
      PatientAddress: "1 Test Street",
      ItemsDetails: [rawLine({ DoctorNotes: "free text" }), rawLine({ ItemCode: "T-TEST-2" })],
      PaymentDetails: [
        rawPayment({ TxnRefName: "Test Cardholder", CardHolderPhone: "+971000000000" }),
      ],
    }),
  ],
});

describe("stripPayload", () => {
  it("drops personal data and unknown fields, keeps the envelope and what the mapper reads", () => {
    const s = JSON.stringify(stripPayload(payload()));
    for (const gone of [
      "Test Patient One",
      "000-0000-0000000-0",
      "1 Test Street",
      "free text",
      "Test Cardholder",
      "+971000000000",
      "drop me",
    ])
      expect(s).not.toContain(gone);
    for (const kept of ["PIN-TEST-1", "ADMC/C/90001", "DataBalancetoSync", "T-TEST-2", "R-TEST-1"])
      expect(s).toContain(kept);
  });

  it("is replay-equivalent: mapping the stripped payload gives the same invoices (minus txn_ref_name)", () => {
    const original = payload();
    const a = mapBatch(original.Data).invoices;
    const b = mapBatch((stripPayload(original) as { Data: unknown[] }).Data).invoices;
    expect(b.map((i) => i.record_hash)).toEqual(a.map((i) => i.record_hash)); // hash excludes txn_ref_name
    expect(b[0].lines).toEqual(a[0].lines);
    expect(b[0].payments[0].txn_ref_name).toBeNull();
    expect(a[0].payments[0].txn_ref_name).toBe("Test Cardholder");
    expect({ ...b[0].payments[0], txn_ref_name: null }).toEqual({
      ...a[0].payments[0],
      txn_ref_name: null,
    });
  });

  it("is idempotent and tolerates odd shapes", () => {
    const once = stripPayload(payload());
    expect(stripPayload(once)).toEqual(once);
    expect(stripPayload(null)).toBeNull();
    expect(stripPayload({ _unparseable: true, text: "x" })).toEqual({});
  });
});

describe("runMaintenance", () => {
  it("strips only eligible batches older than 90 days, then rematches and purges", async () => {
    const saved: Array<{ id: string; payload: unknown }> = [];
    let cutoff = "";
    const res = await runMaintenance({
      now: () => new Date("2026-10-09T00:00:00Z"),
      eligibleBatches: async (c) => {
        cutoff = c;
        return [{ id: "b1", payload: payload() }];
      },
      saveStripped: async (id, p) => void saved.push({ id, payload: p }),
      rematchUnresolved: async () => 4,
      purgeStaleStaging: async () => 2,
    });
    expect(cutoff.startsWith("2026-07-11")).toBe(true);
    expect(res).toEqual({ stripped: 1, rematched: 4, purgedStaging: 2 });
    expect(JSON.stringify(saved[0].payload)).not.toContain("Test Patient One");
  });
});
