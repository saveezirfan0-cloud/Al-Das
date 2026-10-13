/**
 * Phase 22D: the posting builders, rules and line arithmetic (pure). Synthetic fixtures only
 * (context.synthetic.json, sources.synthetic.json).
 */
import { describe, expect, it } from "vitest";

import {
  applyItem,
  buildCashup,
  buildDenial,
  buildFor,
  buildLabStatement,
  buildRemittance,
  buildRevshare,
  buildSettlement,
  buildSupplierInvoice,
  buildUniteInvoice,
  buildUnitePayment,
  buildVoucher,
  monthEnd,
  type CashupRecord,
  type LabStatementRecord,
  type RevshareRecord,
  type SettlementRecord,
  type SupplierInvoiceRecord,
  type UniteInvoiceRecord,
  type UnitePaymentRecord,
  type VoucherRecord,
} from "@/lib/accounting/posting/builders";
import { fils, LineSet } from "@/lib/accounting/posting/lines";
import { findRule, missingMappings, payerKindOf } from "@/lib/accounting/posting/rules";
import {
  parseContext,
  type BuildResult,
  type PostingContext,
} from "@/lib/accounting/posting/types";

import contextJson from "./context.synthetic.json";
import sources from "./sources.synthetic.json";

const ctx: PostingContext = parseContext(contextJson);
const withSettings = (s: Partial<PostingContext["settings"]>): PostingContext => ({
  ...ctx,
  settings: { ...ctx.settings, ...s },
});

/** The posted lines as compact tuples: [account, debit, credit, extras]. */
function lines(r: BuildResult) {
  if (r.action !== "post") throw new Error(`expected a posting, got ${JSON.stringify(r)}`);
  return r.journal.lines.map((l) => {
    const { account_code, debit, credit, ...rest } = l;
    return [account_code, debit, credit, rest] as const;
  });
}
function balanced(r: BuildResult) {
  if (r.action !== "post") return false;
  const d = r.journal.lines.reduce((a, l) => a + fils(l.debit), 0);
  const c = r.journal.lines.reduce((a, l) => a + fils(l.credit), 0);
  return d === c && d > 0;
}
const codes = (r: BuildResult) => (r.action === "reasons" ? r.reasons.map((x) => x.code) : []);
const inv = (patch: Partial<UniteInvoiceRecord> = {}): UniteInvoiceRecord => ({
  ...(sources.selfPayInvoice as UniteInvoiceRecord),
  ...patch,
});

describe("rules", () => {
  it("the most specific rule wins, keys match without case or extra spaces", () => {
    expect(findRule(ctx.rules, "revenue", "Consultation", "P")?.account).toBe("4105");
    expect(findRule(ctx.rules, "revenue", "  consultation ", "G")?.account).toBe("4100");
    expect(findRule(ctx.rules, "payment_mode", "cash", "p")?.account).toBe("1100-P");
    expect(findRule(ctx.rules, "payment_mode", "CASH", "M")).toBeNull();
    expect(findRule(ctx.rules, "receivable", "insurance", "PAYER-SYN-2")?.account).toBe("1201");
    expect(findRule(ctx.rules, "receivable", "insurance", "PAYER-OTHER")?.account).toBe("1200");
    expect(findRule(ctx.rules, "bank_charges", "TABBY")?.tax_code).toBe("VAT5");
    expect(findRule(ctx.rules, "bank_charges", "CARD")?.tax_code).toBeNull();
    expect(findRule(ctx.rules, "service_tax", "Laboratory", "self_pay")).toBeNull();
  });

  it("classifies Unite's invoice types", () => {
    expect(payerKindOf("INSURANCE")).toBe("insurance");
    expect(payerKindOf("Insurance Credit")).toBe("insurance");
    expect(payerKindOf("CORPORATE")).toBe("corporate");
    expect(payerKindOf("SELF PAID")).toBe("self_pay");
    expect(payerKindOf(null)).toBe("self_pay");
  });

  it("parses the context and drops unknown kinds and broken rows", () => {
    const c = parseContext({
      rules: [
        { kind: "revenue", key: "X", account: "4100" },
        { kind: "nonsense", key: "X", account: "1" },
        null,
      ],
      tax_codes: [{ code: "vat5", kind: "standard", rate: "5" }, { kind: "zero" }],
      settings: {
        package_invoices: "weird",
        rounding_tolerance: -3,
        paused_sources: ["voucher", "x"],
      },
      branches: ["P", 3],
    });
    expect(c.rules).toEqual([
      { kind: "revenue", key: "X", qualifier: "*", account: "4100", tax_code: null },
    ]);
    expect([...c.taxCodes.keys()]).toEqual(["VAT5"]);
    expect(c.taxCodes.get("VAT5")!.rate).toBe(5);
    expect(c.settings.packageInvoices).toBe("hold");
    expect(c.settings.roundingTolerance).toBe(0);
    expect(c.settings.pausedSources).toEqual(["voucher"]);
    expect([...c.branches]).toEqual(["P"]);
    expect(parseContext(null).settings.denialAllowanceEnabled).toBe(false);
  });

  it("lists what is not mapped: revenue and VAT per category, modes per branch, categories, providers, single kinds", () => {
    const missing = missingMappings(
      {
        service_categories: ["Consultation", "Laboratory", "Physio"],
        payment_modes: ["CASH", "CARD", "CHEQUE"],
        expense_categories: ["Rent", "Cleaning"],
        provider_kinds: ["send_out_lab"],
        branches: ["G", "M", "P"],
      },
      ctx.rules,
    );
    const keyed = missing.map((m) => `${m.kind}:${m.key}:${m.qualifier}`);
    expect(keyed).toContain("revenue:Physio:*");
    expect(keyed).toContain("service_tax:Laboratory:*");
    expect(keyed).toContain("service_tax:Physio:*");
    expect(keyed).not.toContain("service_tax:Consultation:*");
    expect(keyed).toContain("payment_mode:CASH:M");
    expect(keyed).toContain("payment_mode:CHEQUE:*");
    expect(keyed).not.toContain("payment_mode:CARD:*");
    expect(keyed).toContain("expense:Cleaning:*");
    expect(keyed).not.toContain("expense:Rent:*");
    expect(keyed.filter((k) => k.startsWith("provider_cost"))).toEqual([]);
    expect(keyed.some((k) => k.startsWith("denial_allowance"))).toBe(false);
    expect(
      missingMappings(
        {
          service_categories: [],
          payment_modes: [],
          expense_categories: [],
          provider_kinds: [],
          branches: [],
        },
        [],
        {
          denialAllowance: true,
        },
      ).map((m) => m.kind),
    ).toContain("denial_allowance");
  });
});

describe("lines", () => {
  it("rounds to fils without drift and nets the same account and dimensions", () => {
    expect(fils(1.005)).toBe(101);
    expect(fils("2.675")).toBe(268);
    expect(fils(-0.125)).toBe(-13);
    expect(fils(null)).toBe(0);
    expect(fils("abc")).toBe(0);
    const s = new LineSet();
    s.add("1210", 10050, { branch_code: "P" });
    s.add("1210", -50, { branch_code: "P" });
    s.add("1210", 100, { branch_code: "G" });
    s.add("4100", -10100);
    s.add(null, 999);
    s.add("6900", 0);
    expect(s.balance()).toBe(0);
    expect(s.lines()).toEqual([
      { account_code: "1210", debit: 100, credit: 0, branch_code: "P" },
      { account_code: "1210", debit: 1, credit: 0, branch_code: "G" },
      { account_code: "4100", debit: 0, credit: 101 },
    ]);
  });

  it("knows the last day of a month", () => {
    expect(monthEnd("2027-02-01")).toBe("2027-02-28");
    expect(monthEnd("2028-02-11")).toBe("2028-02-29");
    expect(monthEnd("2027-07-01")).toBe("2027-07-31");
  });
});

describe("Unite invoice", () => {
  it("credits revenue by category and branch with the category's VAT code, discount, VAT and the patient receivable", () => {
    const r = buildUniteInvoice(inv(), ctx);
    const dims = { branch_code: "P", department: "General Practice", doctor_id: "DHA-SYN-1" };
    expect(lines(r)).toEqual([
      ["4105", 0, 220, { ...dims, tax_code: "ZR" }],
      ["6600", 20, 0, dims],
      ["4190", 0, 50, { ...dims, tax_code: "VAT5" }],
      ["2200", 0, 2.5, { branch_code: "P", tax_code: "VAT5" }],
      ["1210", 252.5, 0, { branch_code: "P" }],
    ]);
    expect(balanced(r)).toBe(true);
    if (r.action === "post") {
      expect(r.journal).toMatchObject({
        date: "2027-07-05",
        voucherType: "sales",
        narration: "Unite invoice SYN-INV-0001",
      });
      expect(JSON.stringify(r.journal)).not.toMatch(/pin|patient_name/i);
    }
  });

  it("splits an insurance invoice into each payer's share from the matched claims and the patient's share", () => {
    const r = buildUniteInvoice(sources.insuranceInvoice as UniteInvoiceRecord, ctx);
    const dims = { branch_code: "G", department: "Dermatology" }; // the unknown doctor is left off
    expect(lines(r)).toEqual([
      ["4100", 0, 500, { ...dims, tax_code: "ZR" }],
      ["1200", 290, 0, { branch_code: "G", payer_id: "PAYER-SYN-1" }],
      ["1201", 150, 0, { branch_code: "G", payer_id: "PAYER-SYN-2" }],
      ["1210", 50, 0, { branch_code: "G" }],
      ["6610", 10, 0, dims],
    ]);
    expect(balanced(r)).toBe(true);
  });

  it("books the whole insurance invoice to the insurer until a claim is matched; refuses claims above the invoice", () => {
    const noClaims = buildUniteInvoice(
      { ...(sources.insuranceInvoice as UniteInvoiceRecord), claims: [], write_off: 0 },
      ctx,
    );
    expect(lines(noClaims).map((l) => [l[0], l[1], l[2]])).toEqual([
      ["4100", 0, 500],
      ["1200", 500, 0],
    ]);
    const tooMuch = buildUniteInvoice(
      {
        ...(sources.insuranceInvoice as UniteInvoiceRecord),
        claims: [{ payer_id: "PAYER-SYN-1", amount: 600 }],
      },
      ctx,
    );
    expect(codes(tooMuch)).toEqual(["claims_exceed_invoice"]);
  });

  it("uses the corporate VAT code and the corporate receivable", () => {
    const r = buildUniteInvoice(
      inv({
        inv_type: "CORPORATE",
        total: 105,
        lines: [{ category: "Consultation", discount: 0, net: 100, vat: 5 }],
      }),
      ctx,
    );
    expect(lines(r).map((l) => [l[0], l[1], l[2], l[3].tax_code ?? null])).toEqual([
      ["4105", 0, 100, "VAT5"],
      ["2200", 0, 5, "VAT5"],
      ["1220", 105, 0, null],
    ]);
  });

  it("never guesses a VAT code: a category without one waits (no_tax_code), so does one without a revenue rule", () => {
    const lab = buildUniteInvoice(
      inv({ total: 80, lines: [{ category: "Laboratory", discount: 0, net: 80, vat: 0 }] }),
      ctx,
    );
    expect(lab).toMatchObject({
      action: "reasons",
      reasons: [{ code: "no_tax_code", detail: "VAT code for Laboratory" }],
      date: "2027-07-05",
      amount: 80,
    });
    const physio = buildUniteInvoice(
      inv({ total: 80, lines: [{ category: "Physio", discount: 0, net: 80, vat: 0 }] }),
      ctx,
    );
    expect(codes(physio).sort()).toEqual(["no_rule", "no_tax_code"]);
    const unmapped = buildUniteInvoice(
      inv({ total: 80, lines: [{ category: null, discount: 0, net: 80, vat: 0 }] }),
      ctx,
    );
    expect(unmapped.action === "reasons" && unmapped.reasons.map((x) => x.detail)).toContain(
      "VAT code for Unmapped",
    );
  });

  it("refuses VAT that does not fit the code", () => {
    const zeroWithVat = buildUniteInvoice(
      inv({ total: 105, lines: [{ category: "Consultation", discount: 0, net: 100, vat: 5 }] }),
      ctx,
    );
    expect(codes(zeroWithVat)).toEqual(["vat_mismatch"]);
    const wrongRate = buildUniteInvoice(
      inv({ total: 104, lines: [{ category: "Cosmetic", discount: 0, net: 100, vat: 4 }] }),
      ctx,
    );
    expect(codes(wrongRate)).toEqual(["vat_mismatch"]);
    const withinTolerance = buildUniteInvoice(
      inv({ total: 105.04, lines: [{ category: "Cosmetic", discount: 0, net: 100, vat: 5.04 }] }),
      ctx,
    );
    expect(withinTolerance.action).toBe("post");
  });

  it("puts a small total difference on rounding and refuses a large one", () => {
    const small = buildUniteInvoice(inv({ total: 252.9 }), ctx);
    expect(lines(small).find((l) => l[0] === "6900")).toEqual([
      "6900",
      0,
      0.4,
      { branch_code: "P" },
    ]);
    expect(balanced(small)).toBe(true);
    expect(codes(buildUniteInvoice(inv({ total: 260 }), ctx))).toEqual(["unbalanced"]);
  });

  it("holds package invoices unless the setting posts them; withdraws a deleted invoice; needs a date", () => {
    expect(codes(buildUniteInvoice(inv({ is_package: true }), ctx))).toEqual(["package_deferral"]);
    expect(
      buildUniteInvoice(inv({ is_package: true }), withSettings({ packageInvoices: "post" }))
        .action,
    ).toBe("post");
    expect(buildUniteInvoice(inv({ is_deleted: true }), ctx)).toEqual({ action: "withdraw" });
    expect(codes(buildUniteInvoice(inv({ date: null }), ctx))).toEqual(["no_date"]);
    expect(buildUniteInvoice(inv({ total: 0, lines: [] }), ctx)).toEqual({
      action: "nothing",
      date: "2027-07-05",
    });
  });

  it("credit notes and write-offs reduce the main receivable", () => {
    const r = buildUniteInvoice(inv({ credit_note: 52.5 }), ctx);
    expect(lines(r).filter((l) => ["4990", "1210"].includes(l[0] ?? ""))).toEqual([
      ["1210", 200, 0, { branch_code: "P" }],
      [
        "4990",
        52.5,
        0,
        { branch_code: "P", department: "General Practice", doctor_id: "DHA-SYN-1" },
      ],
    ]);
    expect(balanced(r)).toBe(true);
  });

  it("is deterministic", () => {
    expect(buildUniteInvoice(sources.insuranceInvoice as UniteInvoiceRecord, ctx)).toEqual(
      buildUniteInvoice(structuredClone(sources.insuranceInvoice) as UniteInvoiceRecord, ctx),
    );
  });
});

describe("Unite payment and refund", () => {
  it("debits the branch's cash, credits the patient receivable and the advance", () => {
    const r = buildUnitePayment(sources.cashPayment as UnitePaymentRecord, ctx);
    expect(lines(r)).toEqual([
      ["1100-P", 300, 0, { branch_code: "P" }],
      ["1210", 0, 252.5, { branch_code: "P" }],
      ["2330", 0, 47.5, { branch_code: "P" }],
    ]);
    expect(r.action === "post" && r.journal.voucherType).toBe("receipt");
  });

  it("a refund reverses it through the mode's account", () => {
    const r = buildUnitePayment(sources.cardRefund as UnitePaymentRecord, ctx);
    expect(lines(r)).toEqual([
      ["1210", 40, 0, { branch_code: "G" }],
      ["1300", 0, 40, { branch_code: "G" }],
    ]);
    expect(r.action === "post" && r.journal).toMatchObject({
      voucherType: "payment",
      date: "2027-07-09",
    });
  });

  it("withdraws a superseded payment, posts nothing for zero, waits for an unmapped mode", () => {
    const p = sources.cashPayment as UnitePaymentRecord;
    expect(buildUnitePayment({ ...p, is_current: false }, ctx)).toEqual({ action: "withdraw" });
    expect(buildUnitePayment({ ...p, invoice_deleted: true }, ctx)).toEqual({ action: "withdraw" });
    expect(buildUnitePayment({ ...p, paid: 0, advance: 0 }, ctx).action).toBe("nothing");
    const cheque = buildUnitePayment({ ...p, mode: "CHEQUE" }, ctx);
    expect(cheque).toMatchObject({
      action: "reasons",
      reasons: [{ code: "no_rule", detail: "Payment mode: CHEQUE (P)" }],
    });
    const corporate = buildUnitePayment({ ...p, inv_type: "CORPORATE", advance: 0 }, ctx);
    expect(lines(corporate)[1][0]).toBe("1220");
  });
});

describe("remittance and denial", () => {
  it("a remittance debits the bank and credits each payer's receivable", () => {
    const r = buildRemittance(sources.remittance as Parameters<typeof buildRemittance>[0], ctx);
    expect(lines(r)).toEqual([
      ["1150", 430, 0, {}],
      ["1200", 0, 280, { payer_id: "PAYER-SYN-1" }],
      ["1201", 0, 150, { payer_id: "PAYER-SYN-2" }],
    ]);
    expect(
      buildRemittance(
        { ...(sources.remittance as Parameters<typeof buildRemittance>[0]), lines: [] },
        ctx,
      ).action,
    ).toBe("nothing");
  });

  it("a final denial is written off, or consumes the allowance when that setting is on; a reopened one is withdrawn", () => {
    const d = sources.denial as Parameters<typeof buildDenial>[0];
    expect(lines(buildDenial(d, ctx))).toEqual([
      ["6620", 20, 0, { payer_id: "PAYER-SYN-1" }],
      ["1200", 0, 20, { payer_id: "PAYER-SYN-1" }],
    ]);
    expect(lines(buildDenial(d, withSettings({ denialAllowanceEnabled: true })))[0][0]).toBe(
      "1290",
    );
    expect(buildDenial({ ...d, status: "lost" }, ctx).action).toBe("post");
    for (const status of ["open", "appealed", "won", "recovered", "resubmitted"])
      expect(buildDenial({ ...d, status }, ctx)).toEqual({ action: "withdraw" });
  });
});

describe("supplier invoices and vouchers", () => {
  const bill = (patch: Partial<SupplierInvoiceRecord> = {}): SupplierInvoiceRecord => ({
    ...(sources.supplierInvoice as SupplierInvoiceRecord),
    ...patch,
  });
  const supplier = sources.supplierInvoice.supplier_id;
  const payable = { supplier_id: supplier, party_kind: "supplier", party_id: supplier };

  it("expense, recoverable input VAT, supplier payable", () => {
    expect(lines(buildSupplierInvoice(bill(), ctx))).toEqual([
      ["6200", 1000, 0, { branch_code: "M" }],
      ["2210", 50, 0, {}],
      ["2100", 0, 1050, payable],
    ]);
  });

  it("blocked VAT is part of the cost; reverse charge books both sides; VAT on an exempt code waits", () => {
    expect(lines(buildSupplierInvoice(bill({ category: "Entertainment" }), ctx))).toEqual([
      ["6990", 1050, 0, { branch_code: "M", tax_code: "BLK5" }],
      ["2100", 0, 1050, payable],
    ]);
    expect(lines(buildSupplierInvoice(bill({ category: "Software", vat: 0 }), ctx))).toEqual([
      ["6995", 1000, 0, { branch_code: "M", tax_code: "RC5" }],
      ["2210", 50, 0, { tax_code: "RC5" }],
      ["2200", 0, 50, { tax_code: "RC5" }],
      ["2100", 0, 1000, payable],
    ]);
    expect(codes(buildSupplierInvoice(bill({ category: "Training" }), ctx))).toEqual([
      "vat_mismatch",
    ]);
    expect(codes(buildSupplierInvoice(bill({ category: "Cleaning" }), ctx))).toEqual(["no_rule"]);
    expect(codes(buildSupplierInvoice(bill({ currency: "USD" }), ctx))).toEqual([
      "foreign_currency",
    ]);
    expect(buildSupplierInvoice(bill({ status: "void" }), ctx)).toEqual({ action: "withdraw" });
  });

  it("a paid voucher clears the supplier payable (or the expense) from the bank or the branch cash", () => {
    const v = sources.voucher as VoucherRecord;
    expect(lines(buildVoucher(v, ctx))).toEqual([
      ["2100", 600, 0, payable],
      ["1150", 0, 600, {}],
    ]);
    expect(
      lines(buildVoucher({ ...v, supplier_id: null, method: "cash", branch: "P" }, ctx)),
    ).toEqual([
      ["6200", 600, 0, { branch_code: "P" }],
      ["1100-P", 0, 600, {}],
    ]);
    for (const status of ["draft", "approved", "for_tally", "cancelled", "rejected"])
      expect(buildVoucher({ ...v, status }, ctx)).toEqual({ action: "withdraw" });
  });

  it("leaves a voucher paid by cheque to the cheque register (22K): nothing, or waiting for the cheque", () => {
    const v = { ...(sources.voucher as VoucherRecord), method: "cheque" };
    expect(buildVoucher({ ...v, cheque_live: true }, ctx)).toEqual({
      action: "nothing",
      date: "2027-07-20",
    });
    const w = buildVoucher({ ...v, cheque_live: false }, ctx);
    expect(w.action === "reasons" && w.reasons.map((r) => r.code)).toEqual([
      "cheque_not_registered",
    ]);
    expect(w.action === "reasons" && w.amount).toBe(600);
    // not paid yet: withdrawn as before
    expect(buildVoucher({ ...v, status: "approved", cheque_live: true }, ctx)).toEqual({
      action: "withdraw",
    });
  });
});

describe("revenue share, labs, cash-ups and settlements", () => {
  it("accrues the run per doctor on the month's last day and clears it at the payout", () => {
    const run = buildRevshare(sources.revshareRun as RevshareRecord, ctx);
    expect(run.action === "post" && run.journal.date).toBe("2027-07-31");
    expect(lines(run)).toEqual([
      ["5110", 1200.4, 0, { doctor_id: "DHA-SYN-1" }],
      ["2110", 0, 1200.4, { doctor_id: "DHA-SYN-1", party_kind: "doctor", party_id: "DHA-SYN-1" }],
      ["5110", 800, 0, { doctor_id: "DHA-SYN-2" }],
      ["2110", 0, 800, { doctor_id: "DHA-SYN-2", party_kind: "doctor", party_id: "DHA-SYN-2" }],
    ]);
    const payout = buildRevshare(sources.revsharePayout as RevshareRecord, ctx);
    expect(lines(payout)).toEqual([
      ["2110", 1200.4, 0, { doctor_id: "DHA-SYN-1", party_kind: "doctor", party_id: "DHA-SYN-1" }],
      ["1150", 0, 1200.4, {}],
    ]);
    expect(
      buildRevshare({ ...(sources.revshareRun as RevshareRecord), status: "verified" }, ctx),
    ).toEqual({ action: "withdraw" });
    expect(
      buildRevshare(
        { ...(sources.revsharePayout as RevshareRecord), paid_on: null } as RevshareRecord,
        ctx,
      ),
    ).toEqual({
      action: "withdraw",
    });
  });

  it("spreads a posted lab statement by doctor and branch against the offset", () => {
    const r = buildLabStatement(sources.labStatement as LabStatementRecord, ctx);
    expect(lines(r)).toEqual([
      ["5100", 300, 0, { doctor_id: "DHA-SYN-1", branch_code: "P" }],
      ["5100", 125.5, 0, { doctor_id: "DHA-SYN-2", branch_code: "G" }],
      ["5100", 0, 425.5, {}],
    ]);
    const hospital = buildLabStatement(
      { ...(sources.labStatement as LabStatementRecord), provider_kind: "hospital" },
      ctx,
    );
    expect(lines(hospital).at(-1)).toEqual(["2300", 0, 445.5, {}]);
    expect(
      buildLabStatement({ ...(sources.labStatement as LabStatementRecord), status: "open" }, ctx),
    ).toEqual({
      action: "withdraw",
    });
  });

  it("posts a cash-up's variance against cash over and short", () => {
    const r = buildCashup(sources.cashup as CashupRecord, ctx);
    expect(lines(r)).toEqual([
      ["1100-P", 0, 12.5, { branch_code: "P" }],
      ["6920", 12.5, 0, { branch_code: "P" }],
    ]);
    const c = sources.cashup as CashupRecord;
    expect(buildCashup({ ...c, lines: [{ mode: "CASH", variance: 0 }] }, ctx).action).toBe(
      "nothing",
    );
    expect(buildCashup({ ...c, status: "draft" }, ctx)).toEqual({ action: "withdraw" });
  });

  it("a settlement clears the gross from clearing, books what arrived and the fee (with VAT when the rule says 5%)", () => {
    const r = buildSettlement(sources.settlement as SettlementRecord, ctx);
    expect(lines(r)).toEqual([
      ["1150", 1879, 0, {}],
      ["1310", 0, 2000, {}],
      ["2210", 5.76, 0, { tax_code: "VAT5" }],
      ["6500", 115.24, 0, { tax_code: "VAT5" }],
    ]);
    expect(balanced(r)).toBe(true);
    const card = buildSettlement(
      { ...(sources.settlement as SettlementRecord), mode: "CARD" },
      ctx,
    );
    expect(lines(card).slice(2)).toEqual([["6500", 121, 0, {}]]);
    expect(
      buildSettlement({ ...(sources.settlement as SettlementRecord), matched: false }, ctx),
    ).toEqual({ action: "withdraw" });
  });
});

describe("dispatch", () => {
  it("routes each kind to its builder and shapes the item for acc_posting_apply", () => {
    expect(buildFor("cashup", sources.cashup, ctx)).toEqual(
      buildCashup(sources.cashup as CashupRecord, ctx),
    );
    const post = applyItem("X", buildFor("denial", sources.denial, ctx));
    expect(post).toMatchObject({
      source_id: "X",
      action: "post",
      date: "2027-08-10",
      voucher_type: "journal",
    });
    expect(applyItem("Y", { action: "withdraw" })).toEqual({ source_id: "Y", action: "withdraw" });
    expect(
      applyItem("Z", {
        action: "reasons",
        reasons: [{ code: "no_rule", detail: "d" }],
        date: null,
        amount: 1,
      }),
    ).toEqual({
      source_id: "Z",
      action: "reasons",
      reasons: [{ code: "no_rule", detail: "d" }],
      date: null,
      amount: 1,
    });
  });
});
