import { describe, expect, it } from "vitest";

import {
  allocateOverheads,
  computeProfitability,
  type ProfitInputRow,
} from "@/lib/finance/profitability";
import {
  parseAmount,
  parseCompensation,
  parseMonth,
  parseOverheads,
  parseServiceCosts,
  readCsv,
} from "@/lib/finance/cost-upload";
import { buildProvenance, type ProvenanceFacts } from "@/lib/finance/provenance";

const row = (o: Partial<ProfitInputRow> & { month: string }): ProfitInputRow => ({
  branch_code: "P",
  department: "GP",
  doctor_dha_id: "D1",
  revenue_net: 1000,
  direct_cost: 200,
  costed_net: 1000,
  lines: 10,
  uncosted_lines: 0,
  ...o,
});

describe("profitability", () => {
  it("contribution margin = revenue - direct cost - doctor compensation; profit also takes overhead", () => {
    const r = computeProfitability(
      {
        rows: [row({ month: "2026-09-01" })],
        comp: [{ month: "2026-09-01", doctor_dha_id: "D1", amount: 300 }],
        overheads: [
          { month: "2026-09-01", branch_code: "P", pool: "Rent", amount: 100, basis: "revenue" },
        ],
        approvedMonths: ["2026-09-01"],
      },
      "branch",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      key: "P",
      revenue: 1000,
      directCost: 200,
      doctorComp: 300,
      contributionMargin: 500,
      overhead: 100,
      estimatedProfit: 400,
      coverage: 1,
    });
    expect(r.provisional).toBe(false);
  });

  it("is provisional until the month is approved", () => {
    const r = computeProfitability(
      { rows: [row({ month: "2026-09-01" })], comp: [], overheads: [], approvedMonths: [] },
      "month",
    );
    expect(r.provisional).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/not approved/i);
  });

  it("uncosted revenue lowers coverage and keeps the figure provisional, never free", () => {
    const r = computeProfitability(
      {
        rows: [
          row({
            month: "2026-09-01",
            revenue_net: 1000,
            costed_net: 400,
            direct_cost: 100,
            uncosted_lines: 6,
          }),
        ],
        comp: [],
        overheads: [],
        approvedMonths: ["2026-09-01"],
      },
      "branch",
    );
    expect(r.rows[0].coverage).toBe(0.4);
    expect(r.provisional).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/40% of revenue has a service cost/);
  });

  it("with no cost inputs at all the margin is null, not equal to revenue", () => {
    const r = computeProfitability(
      {
        rows: [row({ month: "2026-09-01", direct_cost: 0, costed_net: 0 })],
        comp: [],
        overheads: [],
        approvedMonths: [],
      },
      "branch",
    );
    expect(r.rows[0].contributionMargin).toBeNull();
    expect(r.rows[0].estimatedProfit).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/No cost inputs/);
  });

  it("without compensation access the result says so and leaves compensation out", () => {
    const r = computeProfitability(
      {
        rows: [row({ month: "2026-09-01" })],
        comp: null,
        overheads: [],
        approvedMonths: ["2026-09-01"],
      },
      "branch",
    );
    expect(r.rows[0].doctorComp).toBeNull();
    expect(r.rows[0].contributionMargin).toBe(800);
    expect(r.reasons.join(" ")).toMatch(/not visible to you/);
  });

  it("splits one doctor's compensation across branches by that doctor's revenue", () => {
    const rows = [
      row({
        month: "2026-09-01",
        branch_code: "P",
        revenue_net: 750,
        costed_net: 750,
        direct_cost: 0,
      }),
      row({
        month: "2026-09-01",
        branch_code: "M",
        revenue_net: 250,
        costed_net: 250,
        direct_cost: 0,
      }),
    ];
    const r = computeProfitability(
      {
        rows,
        comp: [{ month: "2026-09-01", doctor_dha_id: "D1", amount: 400 }],
        overheads: [],
        approvedMonths: ["2026-09-01"],
      },
      "branch",
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by.P.doctorComp).toBe(300);
    expect(by.M.doctorComp).toBe(100);
    expect(r.totals.doctorComp).toBe(400);
  });

  it("by doctor: compensation is that doctor's, overhead is not invented", () => {
    const r = computeProfitability(
      {
        rows: [row({ month: "2026-09-01" })],
        comp: [{ month: "2026-09-01", doctor_dha_id: "D1", amount: 300 }],
        overheads: [
          { month: "2026-09-01", branch_code: null, pool: "Rent", amount: 100, basis: "equal" },
        ],
        approvedMonths: ["2026-09-01"],
      },
      "doctor",
    );
    expect(r.rows[0]).toMatchObject({
      key: "D1",
      doctorComp: 300,
      overhead: null,
      estimatedProfit: null,
      contributionMargin: 500,
    });
  });

  it("compensation for a doctor with no revenue is reported, not silently dropped", () => {
    const r = computeProfitability(
      {
        rows: [row({ month: "2026-09-01" })],
        comp: [{ month: "2026-09-01", doctor_dha_id: "NOBODY", amount: 999 }],
        overheads: [],
        approvedMonths: ["2026-09-01"],
      },
      "branch",
    );
    expect(r.totals.doctorComp).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/no revenue in the range/);
  });
});

describe("overhead allocation", () => {
  const rows = [
    row({ month: "2026-09-01", branch_code: "P", revenue_net: 600, lines: 30 }),
    row({ month: "2026-09-01", branch_code: "M", revenue_net: 400, lines: 10 }),
  ];
  it("shares a pool by revenue, by lines, or equally", () => {
    const pool = (basis: "revenue" | "invoices" | "equal") =>
      allocateOverheads(rows, [
        { month: "2026-09-01", branch_code: null, pool: "Rent", amount: 100, basis },
      ]).byCell;
    expect(pool("revenue").get("2026-09-01|P")).toBeCloseTo(60);
    expect(pool("revenue").get("2026-09-01|M")).toBeCloseTo(40);
    expect(pool("invoices").get("2026-09-01|P")).toBeCloseTo(75);
    expect(pool("equal").get("2026-09-01|M")).toBeCloseTo(50);
  });
  it("allocations add back to the pool exactly", () => {
    const { byCell } = allocateOverheads(rows, [
      { month: "2026-09-01", branch_code: null, pool: "Rent", amount: 100.01, basis: "revenue" },
    ]);
    expect([...byCell.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(100.01, 6);
  });
  it("reports overhead that has nothing to attach to", () => {
    const r = allocateOverheads(rows, [
      { month: "2026-08-01", branch_code: null, pool: "Rent", amount: 50, basis: "revenue" },
      { month: "2026-09-01", branch_code: "G", pool: "Rent", amount: 25, basis: "revenue" },
    ]);
    expect(r.unallocated).toBe(75);
    expect(r.byCell.size).toBe(0);
  });
});

describe("cost CSV", () => {
  it("reads quotes, doubled quotes, CRLF and a BOM", () => {
    expect(readCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("parses amounts strictly", () => {
    expect(parseAmount("1,234.50")).toBe(1234.5);
    for (const bad of ["", "-1", "abc", "1.234", "1e5", "AED 5"])
      expect(parseAmount(bad)).toBeNull();
  });
  it("months must be real and on the first day", () => {
    expect(parseMonth("2026-09")).toBe("2026-09-01");
    expect(parseMonth("2026-09-01")).toBe("2026-09-01");
    expect(parseMonth("2026-09-15")).toBeNull();
    expect(parseMonth("2026-13")).toBeNull();
  });

  it("service costs: valid file, upper-cases codes", () => {
    const r = parseServiceCosts(
      "item_code,effective_from,unit_cost,note\nt-100,2026-01-01,12.50,lab kit\n",
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        { item_code: "T-100", effective_from: "2026-01-01", unit_cost: 12.5, note: "lab kit" },
      ],
    });
  });
  it("service costs: a zero cost is refused (zero means unavailable)", () => {
    const r = parseServiceCosts("item_code,effective_from,unit_cost\nT-1,2026-01-01,0\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/above 0/);
  });
  it("one bad row rejects the whole file; every problem is listed with its row", () => {
    const r = parseServiceCosts(
      "item_code,effective_from,unit_cost\nT-1,2026-02-30,5\nT-2,2026-01-01,x\nT-3,2026-01-01,4\n",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("Row 2"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("Row 3"))).toBe(true);
    }
  });
  it("unknown or missing headers fail closed", () => {
    const r = parseServiceCosts("item,effective_from,unit_cost\nT,2026-01-01,1\n");
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.join(" ")).toMatch(/Unknown column "item"|Missing column "item_code"/);
    expect(parseServiceCosts("").ok).toBe(false);
  });
  it("duplicates inside a file are rejected", () => {
    const r = parseCompensation("month,doctor_dha_id,amount\n2026-09,d1,100\n2026-09,D1,200\n");
    expect(r.ok).toBe(false);
  });
  it("compensation and overheads parse", () => {
    expect(parseCompensation("month,doctor_dha_id,amount\n2026-09,d1,18000\n")).toMatchObject({
      ok: true,
    });
  });
  it("overheads: shared rows default to revenue; branch rows carry no basis", () => {
    const r = parseOverheads(
      "month,branch,pool,amount\n2026-09,,Rent,100\n2026-09,P,Cleaning,50\n",
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          month: "2026-09-01",
          branch_code: null,
          pool: "Rent",
          amount: 100,
          basis: "revenue",
          note: null,
        },
        {
          month: "2026-09-01",
          branch_code: "P",
          pool: "Cleaning",
          amount: 50,
          basis: "revenue",
          note: null,
        },
      ],
    });
  });
  it("limits the number of rows", () => {
    const body = Array.from({ length: 5001 }, (_, i) => `T-${i},2026-01-01,1`).join("\n");
    expect(parseServiceCosts(`item_code,effective_from,unit_cost\n${body}`).ok).toBe(false);
  });
});

describe("provenance", () => {
  const facts: ProvenanceFacts = {
    lastCaptureAt: "2026-10-10T08:00:00Z",
    captureEnabled: true,
    lastImportAt: "2026-10-07T08:00:00Z",
    lastRemittanceAt: null,
    firstInvoiceDate: "2026-02-01",
    lastInvoiceDate: "2026-10-09",
    firstClaimDate: "2026-03-01",
    lastClaimDate: "2026-10-01",
    openExceptions: 4,
    escalatedExceptions: 1,
  };
  it("lists sources, coverage and unresolved exceptions", () => {
    const p = buildProvenance(facts, ["unite", "diligence", "remittance"]);
    expect(p.sources.map((s) => s.key)).toEqual(["unite", "diligence", "remittance"]);
    expect(p.coverage).toEqual([
      { label: "Invoices", from: "2026-02-01", to: "2026-10-09" },
      { label: "Claims", from: "2026-03-01", to: "2026-10-01" },
    ]);
    expect(p.openExceptions).toBe(4);
    expect(p.sources[2].note).toBe("none reconciled yet");
  });
  it("warns when the range starts before the data does", () => {
    const p = buildProvenance(facts, ["unite", "diligence"], {
      from: "2026-01-01",
      to: "2026-10-31",
    });
    expect(p.cautions).toHaveLength(2);
    expect(
      buildProvenance(facts, ["unite"], { from: "2026-02-01", to: "2026-10-31" }).cautions,
    ).toEqual([]);
  });
  it("says so when nothing has been captured", () => {
    const p = buildProvenance(
      { ...facts, firstInvoiceDate: null, lastInvoiceDate: null, captureEnabled: false },
      ["unite"],
    );
    expect(p.cautions).toEqual(["No invoices have been captured yet."]);
    expect(p.sources[0].note).toBe("capture is off");
  });
});

import { mapInvoice } from "@/lib/finance/map-invoice";

import { rawInvoice } from "./factory";

describe("ordering and performing doctor mapping", () => {
  it("is absent when Unite does not send it, and the invoice hash does not change when it does", () => {
    const plain = mapInvoice(rawInvoice());
    expect(plain.doctor_roles).toBeUndefined();
    const withRoles = mapInvoice(
      rawInvoice({ OrderingDoctorDHAId: "ord-1", PerformingDoctorName: "Dr Test Performing" }),
    );
    expect(withRoles.doctor_roles).toEqual({
      ordering_id: "ord-1",
      ordering_name: null,
      performing_id: null,
      performing_name: "Dr Test Performing",
    });
    // stored apart from the invoice: same business content, same hash, same doctor
    expect(withRoles.record_hash).toBe(plain.record_hash);
    expect(withRoles.doctor_dha_id).toBe(plain.doctor_dha_id);
    expect(JSON.stringify(withRoles.record)).not.toContain("ord-1");
  });
});

import { parseInsuranceOverview, rate } from "@/lib/finance/insurance-overview";

describe("insurance overview parsing", () => {
  it("always returns the four ageing buckets in order and zeroes for anything missing", () => {
    const o = parseInsuranceOverview({
      totals: {
        submitted: "10",
        accepted: 4,
        rejected: 2,
        pending: 4,
        no_status: 1,
        claimed: "1000.5",
        avg_days_to_pay: null,
      },
      ageing: [
        { bucket: "90+", claims: 2, outstanding: 50 },
        { bucket: "0-30", claims: 1, outstanding: 10 },
      ],
      payers: [
        { payer_id: "P1", payer_name: "Payer One", claims: 5, rejected: 1, outstanding: 30 },
        { payer_id: null },
      ],
    });
    expect(o.totals).toMatchObject({
      submitted: 10,
      accepted: 4,
      claimed: 1000.5,
      paidAllocated: 0,
      avgDaysToPay: null,
    });
    expect(o.ageing.map((a) => [a.bucket, a.outstanding])).toEqual([
      ["0-30", 10],
      ["31-60", 0],
      ["61-90", 0],
      ["90+", 50],
    ]);
    expect(o.payers[0]).toMatchObject({ payerId: "P1", payerName: "Payer One", outstanding: 30 });
    expect(o.payers[1]).toMatchObject({ payerId: "(no payer)", payerName: null, claims: 0 });
  });
  it("survives garbage and empty input", () => {
    for (const bad of [null, undefined, 5, "x", [], { totals: 3, ageing: "no", payers: {} }]) {
      const o = parseInsuranceOverview(bad);
      expect(o.totals.submitted).toBe(0);
      expect(o.ageing).toHaveLength(4);
      expect(o.payers).toEqual([]);
    }
  });
  it("rates avoid dividing by zero", () => {
    expect(rate(1, 0)).toBeNull();
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(3, 3)).toBe(100);
  });
});
