import { describe, expect, it } from "vitest";

import { permissionMatches } from "@/lib/auth/permissions";
import {
  voucherCanonical,
  voucherContentHash,
  type VoucherContent,
} from "@/lib/finance/voucher-hash";
import {
  allocateVoucherPayment,
  approvalRoute,
  canReadVoucher,
  formatVoucherNumber,
  rejectPermission,
  requiredApprovals,
  tierProblems,
  unusualFlags,
  voucherEdited,
  voucherReport,
  voucherReadAccess,
  voucherTransition,
  waitingFor,
  type ApprovalTier,
  type SpecialCategory,
  type VoucherAction,
  type VoucherMachineState,
  type VoucherReportRow,
} from "@/lib/finance/vouchers";

import fixture from "./fixtures/phase20d-vouchers.synthetic.json";

const TIERS = fixture.tiers as ApprovalTier[];
const STALE = "f".repeat(64);

type Step = {
  actor: string;
  action: VoucherAction | "edit";
  hash?: "current" | "stale";
  remarks?: string;
  payment?: { date: string; reference: string };
  expect: string;
};

/** Runs one fixture scenario through the pure mirror and returns the outcome of every step. */
function runScenario(s: (typeof fixture.scenarios)[number]): string[] {
  const actors = fixture.actors as Record<string, string[]>;
  const tiers = TIERS.map((t) => ({
    ...t,
    active: t.active && !((s as { inactiveTiers?: string[] }).inactiveTiers ?? []).includes(t.code),
  }));
  const special = ((s as { special?: string }).special ?? "none") as SpecialCategory;
  let version = 0;
  let state: VoucherMachineState = {
    status: "draft",
    route: null,
    needsDept: false,
    needsCeo: false,
    bulkAllowed: false,
    tier: null,
    makers: [(s as { creator?: string }).creator ?? "maker"],
    checkedBy: null,
    deptBy: null,
    ceoBy: null,
    contentHash: null,
    currentHash: `h${version}`,
    locked: !!(s as { locked?: boolean }).locked,
    exported: false,
    documents: (s as { documents?: number }).documents ?? 1,
    blockedDocuments: 0,
  };
  const out: string[] = [];
  for (const step of s.steps as Step[]) {
    if (step.action === "edit") {
      const r = voucherEdited(state, step.actor, `h${++version}`);
      if (r.ok) state = r.state;
      out.push(r.ok ? r.state.status : r.code);
      continue;
    }
    const perms = actors[step.actor];
    const r = voucherTransition(state, step.action, {
      actor: step.actor,
      can: (p) => perms.some((g) => permissionMatches(g, p)),
      hash: step.hash === "stale" ? STALE : state.contentHash,
      remarks: step.remarks ?? null,
      approvalMode: ((s as { approvalMode?: string }).approvalMode ?? "pulse") as "pulse" | "tally",
      rule: requiredApprovals(s.amount, special, tiers),
      payment: step.payment ?? null,
    });
    if (r.ok) state = r.state;
    out.push(r.ok ? r.state.status : r.code);
  }
  return out;
}

describe("delegation of authority (CEO directive tiers)", () => {
  it.each(fixture.routing)("$amount ($special) goes to $tier", (r) => {
    expect(requiredApprovals(r.amount, r.special as SpecialCategory, TIERS)?.tier).toBe(r.tier);
  });

  it("Tier 1 needs only the Finance Manager and may be verified in bulk; Tier 2 adds the department head; Tier 3 and 4 the CEO", () => {
    expect(requiredApprovals(100, "none", TIERS)).toMatchObject({
      needsDept: false,
      needsCeo: false,
      bulkAllowed: true,
    });
    expect(requiredApprovals(6000, "none", TIERS)).toMatchObject({
      needsDept: true,
      needsCeo: false,
      bulkAllowed: false,
    });
    expect(requiredApprovals(20000, "none", TIERS)).toMatchObject({
      needsDept: false,
      needsCeo: true,
    });
    expect(requiredApprovals(60000, "none", TIERS)).toMatchObject({
      needsDept: false,
      needsCeo: true,
    });
    for (const sp of ["payroll", "intercompany", "related_party"] as const)
      expect(requiredApprovals(1, sp, TIERS)?.needsCeo, sp).toBe(true);
  });

  it("fails closed: no rule, overlapping rules, or an inactive rule give null", () => {
    expect(
      requiredApprovals(
        8000,
        "none",
        TIERS.map((t) => (t.code === "T2" ? { ...t, active: false } : t)),
      ),
    ).toBeNull();
    expect(
      requiredApprovals(
        10,
        "payroll",
        TIERS.filter((t) => t.code !== "SP_PAYROLL"),
      ),
    ).toBeNull();
    const overlap = [...TIERS, { ...TIERS[0], code: "T1B", minAmount: 4000, maxAmount: 6000 }];
    expect(requiredApprovals(4500, "none", overlap)).toBeNull();
  });

  it("tierProblems is quiet for the directive's defaults and names gaps, overlaps and weak special rules", () => {
    expect(tierProblems(TIERS)).toEqual([]);
    const gap = TIERS.map((t) => (t.code === "T2" ? { ...t, minAmount: 6000 } : t));
    expect(tierProblems(gap).join(" ")).toMatch(/between 5000 and 6000/);
    const overlap = TIERS.map((t) => (t.code === "T2" ? { ...t, minAmount: 4000 } : t));
    expect(tierProblems(overlap).join(" ")).toMatch(/overlap/);
    const weak = TIERS.map((t) => (t.code === "SP_PAYROLL" ? { ...t, needsCeo: false } : t));
    expect(tierProblems(weak).join(" ")).toMatch(/CEO/);
    expect(tierProblems(TIERS.filter((t) => t.code !== "T4")).join(" ")).toMatch(/above 50000/);
  });
});

describe("the approval state machine (shared fixture; the database runs the same scenarios)", () => {
  it.each(fixture.scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    expect(runScenario(s)).toEqual(s.steps.map((x) => x.expect));
  });

  it("knows who acts next", () => {
    expect(waitingFor({ status: "submitted", needsDept: true, needsCeo: false }).step).toBe(
      "check",
    );
    expect(waitingFor({ status: "checked", needsDept: true, needsCeo: true }).step).toBe(
      "approve_dept",
    );
    expect(waitingFor({ status: "dept_approved", needsDept: true, needsCeo: true }).step).toBe(
      "approve_ceo",
    );
    expect(waitingFor({ status: "checked", needsDept: false, needsCeo: true }).step).toBe(
      "approve_ceo",
    );
    expect(waitingFor({ status: "approved", needsDept: false, needsCeo: false }).step).toBe("pay");
    expect(waitingFor({ status: "for_tally", needsDept: false, needsCeo: false }).step).toBe("pay");
    expect(waitingFor({ status: "paid", needsDept: false, needsCeo: false }).step).toBeNull();
    expect(rejectPermission({ status: "submitted", needsDept: true })).toBe(
      "finance.vouchers.check",
    );
    expect(rejectPermission({ status: "checked", needsDept: false })).toBe(
      "finance.vouchers.approve_ceo",
    );
    expect(rejectPermission({ status: "approved", needsDept: false })).toBeNull();
  });

  it("describes the route for people", () => {
    expect(approvalRoute({ route: "pulse", tier: "T2", needsDept: true, needsCeo: false })).toBe(
      "T2: Maker > Finance Manager > Department head",
    );
    expect(
      approvalRoute({ route: "tally", tier: null, needsDept: false, needsCeo: false }),
    ).toMatch(/Tally/);
    expect(approvalRoute({ route: null, tier: null, needsDept: false, needsCeo: false })).toBe(
      "Not submitted",
    );
  });
});

describe("content fingerprint and numbering", () => {
  const base: VoucherContent = {
    id: "0B6E6F2A-1D3C-4E5F-8A9B-0C1D2E3F4A5B",
    orgId: "11111111-2222-4333-8444-555555555555",
    voucherNo: "PV-2026-0007",
    voucherDate: "2026-10-05",
    payeeName: "Supplier Test 01",
    supplierId: null,
    amount: 1200.5,
    currency: "AED",
    category: "Consumables",
    special: "none",
    branchCode: "P",
    costCentre: null,
    payFrom: "BANK-MAIN",
    paymentMethod: "bank_transfer",
    narration: "Gloves\nand masks \\ October",
    invoices: [
      { id: "bbbbbbbb-0000-4000-8000-000000000002", total: "105" },
      { id: "aaaaaaaa-0000-4000-8000-000000000001", total: 50.5 },
    ],
    documentHashes: ["B".repeat(64), "a".repeat(64), "b".repeat(64)],
  };

  it("builds a stable canonical text: escaped text, lower-case ids, two decimals, sorted and de-duplicated lists", () => {
    const t = voucherCanonical(base);
    expect(t.split("\n")).toEqual([
      "pulse-voucher-v1",
      "id:0b6e6f2a-1d3c-4e5f-8a9b-0c1d2e3f4a5b",
      "org:11111111-2222-4333-8444-555555555555",
      "number:PV-2026-0007",
      "date:2026-10-05",
      "payee:Supplier Test 01",
      "supplier:-",
      "amount:1200.50",
      "currency:AED",
      "category:Consumables",
      "special:none",
      "branch:P",
      "cost_centre:-",
      "pay_from:BANK-MAIN",
      "method:bank_transfer",
      "narration:Gloves\\nand masks \\\\ October",
      "invoices:aaaaaaaa-0000-4000-8000-000000000001=50.50,bbbbbbbb-0000-4000-8000-000000000002=105.00",
      `documents:${"a".repeat(64)},${"b".repeat(64)}`,
    ]);
  });

  it("changes when any field or attachment changes, and only then", () => {
    const h = voucherContentHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      voucherContentHash({ ...base, documentHashes: [...base.documentHashes].reverse() }),
    ).toBe(h);
    expect(voucherContentHash({ ...base, amount: "1200.50" })).toBe(h);
    expect(voucherContentHash({ ...base, amount: 1200.51 })).not.toBe(h);
    expect(voucherContentHash({ ...base, narration: "Gloves and masks" })).not.toBe(h);
    expect(voucherContentHash({ ...base, documentHashes: ["c".repeat(64)] })).not.toBe(h);
    expect(voucherContentHash({ ...base, invoices: [] })).not.toBe(h);
  });

  it("numbers vouchers PV-<year>-<4 digits>, growing past 9999", () => {
    expect(formatVoucherNumber(2026, 1)).toBe("PV-2026-0001");
    expect(formatVoucherNumber(2026, 12345)).toBe("PV-2026-12345");
    expect(() => formatVoucherNumber(2026, 0)).toThrow();
  });
});

describe("status and exception report", () => {
  const settings = { duplicateWindowDays: 30, mismatchTolerance: 1, largeAmount: 50000 };
  const row = (p: Partial<VoucherReportRow>): VoucherReportRow => ({
    id: p.id ?? "v",
    voucherNo: "PV-2026-0001",
    voucherDate: "2026-10-05",
    payeeName: "Supplier Test 01",
    supplierId: null,
    amount: 100,
    status: "approved",
    special: "none",
    tier: "T1",
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    rejectionRemarks: null,
    invoicesTotal: 100,
    ...p,
  });

  it("flags invoice mismatches, possible duplicates, large amounts without an invoice and special categories", () => {
    const flags = unusualFlags(
      [
        row({ id: "a", amount: 100, invoicesTotal: 98.5 }),
        row({
          id: "b",
          amount: 100,
          invoicesTotal: 100,
          voucherDate: "2026-10-20",
          payeeName: " supplier test 01",
        }),
        row({ id: "c", amount: 60000, invoicesTotal: null, payeeName: "Supplier Test 02" }),
        row({
          id: "d",
          amount: 10,
          special: "payroll",
          payeeName: "Payroll Test",
          invoicesTotal: null,
        }),
        row({ id: "e", amount: 100, payeeName: "Supplier Test 01", voucherDate: "2026-12-30" }),
        row({ id: "f", amount: 100, payeeName: "Supplier Test 01", status: "cancelled" }),
      ],
      settings,
    );
    expect(flags.get("a")).toEqual(["invoice_mismatch", "possible_duplicate"]);
    expect(flags.get("b")).toEqual(["possible_duplicate"]);
    expect(flags.get("c")).toEqual(["no_invoice_large"]);
    expect(flags.get("d")).toEqual(["special"]);
    expect(flags.has("e")).toBe(false); // 70+ days from the others
    expect(flags.has("f")).toBe(false); // cancelled vouchers are ignored
  });

  it("counts pending by stage, approved, paid and rejected, and averages approval time", () => {
    const r = voucherReport(
      [
        row({ id: "1", status: "submitted", amount: 10 }),
        row({ id: "2", status: "checked", amount: 20, tier: "T3" }),
        row({
          id: "3",
          status: "approved",
          amount: 30,
          submittedAt: "2026-10-05T08:00:00Z",
          approvedAt: "2026-10-05T12:00:00Z",
        }),
        row({
          id: "4",
          status: "paid",
          amount: 40,
          submittedAt: "2026-10-05T08:00:00Z",
          approvedAt: "2026-10-06T08:00:00Z",
        }),
        row({
          id: "5",
          status: "rejected",
          amount: 50,
          rejectedAt: "2026-10-06T09:00:00Z",
          rejectionRemarks: "Quotation missing",
        }),
        row({ id: "6", status: "cancelled", amount: 60 }),
      ],
      settings,
    );
    expect(r.pending.find((p) => p.status === "submitted")).toMatchObject({ count: 1, amount: 10 });
    expect(r.pending.find((p) => p.status === "checked")).toMatchObject({ count: 1, amount: 20 });
    expect(r.approved).toEqual({ count: 1, amount: 30 });
    expect(r.paid).toEqual({ count: 1, amount: 40 });
    expect(r.rejected).toEqual({ count: 1, amount: 50 });
    expect(r.averageApprovalHours).toBe(14); // (4 + 24) / 2
    expect(r.rejectedRows.map((x) => x.id)).toEqual(["5"]);
    expect(r.byTier.find((t) => t.tier === "T1")).toMatchObject({
      count: 4,
      averageApprovalHours: 14,
    });
  });
});

describe("part payments (allocateVoucherPayment, mirrored by fin_voucher_act pay)", () => {
  const inv = (id: string, date: string, number: string, total: number, paid = 0) => ({
    id,
    date,
    number,
    total,
    paid,
  });

  it("pays the oldest invoice first (then by number, then id) and leaves the rest open", () => {
    const r = allocateVoucherPayment(
      700,
      [inv("b", "2026-09-10", "INV-2", 300), inv("a", "2026-09-01", "INV-9", 1050)],
      1,
    );
    expect(r).toEqual([
      { id: "a", allocated: 700, paidAfter: 700, status: "open" },
      { id: "b", allocated: 0, paidAfter: 0, status: "open" },
    ]);
    const sameDay = allocateVoucherPayment(
      100,
      [inv("z", "2026-09-01", "INV-B", 60), inv("y", "2026-09-01", "INV-A", 60)],
      0,
    );
    expect(sameDay.map((x) => [x.id, x.allocated, x.status])).toEqual([
      ["y", 60, "paid"],
      ["z", 40, "open"],
    ]);
  });

  it("an invoice is paid only once its balance is settled within the tolerance", () => {
    expect(allocateVoucherPayment(500, [inv("a", "2026-09-01", "I", 1050)], 1)[0]).toEqual({
      id: "a",
      allocated: 500,
      paidAfter: 500,
      status: "open",
    });
    expect(allocateVoucherPayment(549.5, [inv("a", "2026-09-01", "I", 1050, 500)], 1)[0]).toEqual({
      id: "a",
      allocated: 549.5,
      paidAfter: 1049.5,
      status: "paid",
    });
    expect(
      allocateVoucherPayment(548.99, [inv("a", "2026-09-01", "I", 1050, 500)], 1)[0].status,
    ).toBe("open");
    // never more than the balance; cents stay exact
    expect(
      allocateVoucherPayment(
        0.3,
        [inv("a", "2026-09-01", "I", 0.1), inv("b", "2026-09-02", "J", 0.2)],
        0,
      ),
    ).toEqual([
      { id: "a", allocated: 0.1, paidAfter: 0.1, status: "paid" },
      { id: "b", allocated: 0.2, paidAfter: 0.2, status: "paid" },
    ]);
    expect(
      allocateVoucherPayment(5000, [inv("a", "2026-09-01", "I", 100, 40)], 1)[0],
    ).toMatchObject({
      allocated: 60,
      paidAfter: 100,
      status: "paid",
    });
  });
});

describe("who reads which voucher (voucherReadAccess / canReadVoucher, mirrored by app.fin_can_read_voucher)", () => {
  const access = (...perms: string[]) =>
    voucherReadAccess((p) => perms.some((g) => permissionMatches(g, p)));
  const row = (over: Partial<Parameters<typeof canReadVoucher>[1]> = {}) => ({
    special: "none" as SpecialCategory,
    route: "pulse" as const,
    needsDept: true,
    status: "checked" as const,
    deciders: [] as string[],
    ...over,
  });

  it("a department head reads a Tier 2 voucher waiting for a department head, or one they decided, and nothing else", () => {
    const dept = access("finance.vouchers.approve_dept");
    expect(dept).toEqual({ full: false, special: false, dept: true });
    expect(canReadVoucher(dept, row(), "u1")).toBe(true);
    expect(canReadVoucher(dept, row({ status: "approved", deciders: ["u1"] }), "u1")).toBe(true);
    expect(canReadVoucher(dept, row({ status: "approved", deciders: ["u2"] }), "u1")).toBe(false);
    expect(canReadVoucher(dept, row({ status: "submitted" }), "u1")).toBe(false);
    expect(canReadVoucher(dept, row({ needsDept: false }), "u1")).toBe(false);
    expect(canReadVoucher(dept, row({ route: "tally" }), "u1")).toBe(false);
    expect(canReadVoucher(dept, row({ special: "payroll" }), "u1")).toBe(false);
  });

  it("special categories need the checker, CEO or compensation key on top of a payables key", () => {
    const payroll = row({ special: "payroll", needsDept: false });
    expect(canReadVoucher(access("finance.tally.export"), payroll, "u")).toBe(false);
    expect(canReadVoucher(access("finance.vouchers.pay"), payroll, "u")).toBe(false);
    expect(canReadVoucher(access("finance.costs.compensation"), payroll, "u")).toBe(false);
    expect(
      canReadVoucher(access("finance.payables.view", "finance.vouchers.approve_ceo"), payroll, "u"),
    ).toBe(true);
    expect(canReadVoucher(access("finance.vouchers.check"), payroll, "u")).toBe(true);
    expect(
      canReadVoucher(
        access("finance.vouchers.prepare", "finance.costs.compensation"),
        payroll,
        "u",
      ),
    ).toBe(true);
    expect(canReadVoucher(access("*"), payroll, "u")).toBe(true);
    expect(canReadVoucher(access("finance.tally.export"), row({ needsDept: false }), "u")).toBe(
      true,
    );
    expect(canReadVoucher(access(), row(), "u")).toBe(false);
  });
});
