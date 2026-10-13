/**
 * Phase 22I: the Tally XML reader and the import dry run (pure). Synthetic fixtures only (fake company "Demo Clinic"),
 * written by hand in ./fixtures, in UTF-8, UTF-16 LE and UTF-16 BE. Never a real Tally export.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseTallyAmount,
  parseTallyDate,
  TALLY_DEBIT_SIGN,
  tallyIsDebit,
  tallyToDrMinusCr,
} from "@/lib/accounting/tally/amounts";
import { parseTallyXml, type TallyParseResult } from "@/lib/accounting/tally/parse";
import {
  dayBeforeMonth,
  mergeParsed,
  planTallyImport,
  resolveVoucherType,
  type PlanAccount,
  type PlanContext,
} from "@/lib/accounting/tally/plan";
import { parseTrialBalanceTable } from "@/lib/accounting/tally/tb-file";
import {
  decodeEntities,
  decodeTallyBytes,
  MAX_TALLY_BYTES,
  TallyParseError,
} from "@/lib/accounting/tally/xml";
import { TALLY_GROUPS } from "@/lib/accounting/tally-groups";
import { buildTallyXml } from "@/lib/finance/tally-xml";

const dir = join(__dirname, "fixtures");
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const masters = () => parseTallyXml(file("masters.xml"));
const vouchers = () => parseTallyXml(file("vouchers.xml"));
const withoutEncoding = (r: TallyParseResult) => ({ ...r, encoding: "x" });

/** A context like a freshly seeded Pulse chart: Tally's 28 system groups and a retained earnings control ledger. */
function seededContext(extra: Partial<PlanContext> = {}): PlanContext {
  const accounts: PlanAccount[] = [
    ...TALLY_GROUPS.map((g) => ({
      id: `id-${g.code}`,
      code: g.code,
      name: g.name,
      is_group: true,
      is_system: true,
      tally_guid: null,
      tally_group: g.name,
      control: null,
    })),
    {
      id: "id-3100",
      code: "3100",
      name: "Retained earnings",
      is_group: false,
      is_system: false,
      tally_guid: null,
      tally_group: "Reserves & Surplus",
      control: "retained_earnings",
    },
    {
      id: "id-6200",
      code: "6200",
      name: "Rent",
      is_group: false,
      is_system: false,
      tally_guid: null,
      tally_group: "Indirect Expenses",
      control: null,
    },
  ];
  return { accounts, costCentres: [], tallyJournals: [], ...extra };
}

describe("Tally sign convention (single constant)", () => {
  it("a debit is negative in Tally and positive in Pulse (debit minus credit)", () => {
    expect(TALLY_DEBIT_SIGN).toBe(-1);
    expect(tallyIsDebit(-1050)).toBe(true);
    expect(tallyIsDebit(1050)).toBe(false);
    expect(tallyIsDebit(0)).toBe(false);
    expect(tallyToDrMinusCr(-5_000_000)).toBe(5_000_000);
    expect(tallyToDrMinusCr(3_000_000)).toBe(-3_000_000);
    expect(tallyToDrMinusCr(0)).toBe(0);
  });

  it("matches Pulse's own Tally exporter: what it writes as a debit is read back as a debit", () => {
    const built = buildTallyXml({
      company: "Demo Clinic LLC",
      costCategory: "Branches",
      ledgers: [
        { kind: "supplier", key: "s1", ledger_name: "Supplier Demo B" },
        { kind: "category", key: "Rent", ledger_name: "Rent Demo" },
        { kind: "vat_input", key: "*", ledger_name: "VAT Input Demo" },
        { kind: "bank", key: "bank", ledger_name: "Bank - Demo Main" },
        { kind: "cost_centre", key: "N", ledger_name: "Branch Demo North" },
      ],
      purchases: [
        {
          id: "p1",
          supplierId: "s1",
          supplierName: "Supplier Demo B",
          invoiceNumber: "INV-1",
          invoiceDate: "2026-07-03",
          category: "Rent",
          net: 1000,
          vat: 50,
          branchCode: "N",
        },
      ],
      payments: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseTallyXml(new TextEncoder().encode(built.xml));
    expect(parsed.vouchers).toHaveLength(1);
    const v = parsed.vouchers[0];
    expect(v.problems).toEqual(["no_guid"]); // the exporter writes no GUID; the import refuses such vouchers
    expect(v.entries.map((e) => [e.ledger, e.side, e.cents])).toEqual([
      ["Rent Demo", "debit", 100_000],
      ["VAT Input Demo", "debit", 5_000],
      ["Supplier Demo B", "credit", 105_000],
    ]);
    expect(v.entries[0].costCentres).toEqual([
      { category: "Branches", name: "Branch Demo North", cents: 100_000 },
    ]);
  });
});

describe("amounts and dates", () => {
  it("reads plain, bracketed and blank amounts in cents", () => {
    expect(parseTallyAmount("-10500.00")).toEqual({ ok: true, cents: -1_050_000, fx: null });
    expect(parseTallyAmount("1,234.5")).toEqual({ ok: true, cents: 123_450, fx: null });
    expect(parseTallyAmount("(12.00)")).toEqual({ ok: true, cents: -1_200, fx: null });
    expect(parseTallyAmount("")).toEqual({ ok: true, cents: 0, fx: null });
    expect(parseTallyAmount("100.000")).toEqual({ ok: true, cents: 10_000, fx: null });
    expect(parseTallyAmount("100.005")).toEqual({ ok: false });
    expect(parseTallyAmount("abc")).toEqual({ ok: false });
  });

  it("takes the base amount after '=' in a foreign-currency amount and keeps the rest as information", () => {
    expect(parseTallyAmount("-100.00 USD @ AED 3.6725/USD = -367.25")).toEqual({
      ok: true,
      cents: -36_725,
      fx: { amountFx: 100, currency: "USD", rate: 3.6725 },
    });
    expect(parseTallyAmount("-$100.00 @ AED 3.6725/$ = -AED 367.25")).toEqual({
      ok: true,
      cents: -36_725,
      fx: { amountFx: 100, currency: null, rate: 3.6725 },
    });
    expect(parseTallyAmount("-100.00 USD @ AED 3.6725/USD = ")).toEqual({ ok: false });
  });

  it("reads YYYYMMDD dates and refuses impossible ones", () => {
    expect(parseTallyDate("20260705")).toBe("2026-07-05");
    expect(parseTallyDate("20250229")).toBeNull();
    expect(parseTallyDate("2026-07-05")).toBeNull();
    expect(dayBeforeMonth("2026-07-10")).toBe("2026-06-30");
    expect(dayBeforeMonth("2024-03-02")).toBe("2024-02-29");
  });
});

describe("decoding", () => {
  it("drops Tally's &#4; marker and other control characters", () => {
    expect(decodeEntities("&#4; Not Applicable")).toBe(" Not Applicable");
    expect(decodeEntities("A\u0004B&amp;C&#x41;&#0;&#65;&nbsp;")).toBe("AB&CAA&nbsp;");
  });

  it("detects UTF-16 with and without a byte order mark", () => {
    const xml = "<ENVELOPE><X>é</X></ENVELOPE>";
    const le = Buffer.from(xml, "utf16le");
    expect(decodeTallyBytes(new Uint8Array(le))).toEqual({ text: xml, encoding: "utf-16le" });
    expect(
      decodeTallyBytes(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))),
    ).toEqual({
      text: xml,
      encoding: "utf-16le",
    });
    const be = Buffer.from(le);
    be.swap16();
    expect(decodeTallyBytes(new Uint8Array(be)).text).toBe(xml);
    expect(decodeTallyBytes(new Uint8Array(Buffer.from("﻿" + xml, "utf8"))).text).toBe(xml);
  });

  it("refuses an oversized file and a file that is not XML", () => {
    const big = new Uint8Array(4);
    Object.defineProperty(big, "length", { value: MAX_TALLY_BYTES + 1 });
    expect(() => decodeTallyBytes(big)).toThrow(TallyParseError);
    expect(() => parseTallyXml(new TextEncoder().encode("Name,Debit\nA,1"))).toThrow(/not an XML/);
    expect(() => parseTallyXml(new TextEncoder().encode("   "))).toThrow(/empty/);
  });

  it("gives the same records for the UTF-8, UTF-16 LE and UTF-16 BE versions of the fixtures", () => {
    const m8 = masters();
    const m16 = parseTallyXml(file("masters.utf16be.xml"));
    expect(m16.encoding).toBe("utf-16be");
    expect(withoutEncoding(m16)).toEqual(withoutEncoding(m8));
    const v8 = vouchers();
    const v16 = parseTallyXml(file("vouchers.utf16le.xml"));
    expect(v16.encoding).toBe("utf-16le");
    expect(withoutEncoding(v16)).toEqual(withoutEncoding(v8));
  });
});

describe("parsing the masters", () => {
  const m = masters();

  it("reads the report and company names and counts each kind", () => {
    expect(m.reportName).toBe("All Masters");
    expect(m.company).toBe("Demo Clinic LLC");
    expect(m.groups).toHaveLength(12);
    expect(m.ledgers).toHaveLength(11);
    expect(m.costCentres).toHaveLength(3);
    expect(m.currencies).toEqual([{ symbol: "$", iso: "USD" }]);
    expect(m.voucherTypes.map((t) => [t.name, t.parent])).toEqual([
      ["Receipt", "Receipt"],
      ["Insurance Receipt", "Receipt"],
      ["Cash Sales", "Sales"],
      ["Memo Demo", "Memorandum"],
    ]);
    expect(m.otherObjects).toBe(1); // the UNIT
    expect(m.vouchers).toEqual([]);
  });

  it("treats 'Primary', blank and Tally's blank marker as no parent, and keeps the nature flags", () => {
    const g = (n: string) => m.groups.find((x) => x.name === n)!;
    expect(g("Current Assets").parent).toBeNull();
    expect(g("Demo Primary Income")).toMatchObject({
      parent: null,
      isRevenue: true,
      isDeemedPositive: false,
    });
    expect(g("Insurance Receivables")).toMatchObject({
      parent: "Sundry Debtors",
      guid: "demo-guid-grp-insrec",
      alterId: 3,
    });
    expect(g("Duties & Taxes").parent).toBe("Current Liabilities");
    expect(m.costCentres.find((c) => c.name === "Branch Demo North")!.parent).toBeNull();
  });

  it("converts opening balances with the sign convention (negative in Tally = debit)", () => {
    const o = Object.fromEntries(m.ledgers.map((l) => [l.name, l.openingDrMinusCr]));
    expect(o["Bank - Demo Main"]).toBe(5_000_000);
    expect(o["Insurer Demo A"]).toBe(12_500_000);
    expect(o["Supplier Demo B"]).toBe(-3_000_000);
    expect(o["Owner Capital Demo"]).toBe(-10_000_000);
    expect(o["Profit & Loss A/c"]).toBe(-4_700_000);
    expect(o["Consultation Fees Demo"]).toBe(0);
    expect(m.ledgers.find((l) => l.name === "Insurer Demo A")!.openingBills).toBe(1);
    expect(m.ledgers.find((l) => l.name === "Profit & Loss A/c")!.parent).toBeNull();
  });
});

describe("parsing the vouchers", () => {
  const v = vouchers();
  const byGuid = (g: string) => v.vouchers.find((x) => x.guid === g)!;

  it("reads every voucher with its flags", () => {
    expect(v.vouchers).toHaveLength(11);
    expect(byGuid("demo-guid-v1")).toMatchObject({
      alterId: 101,
      masterId: 1,
      date: "2026-07-05",
      typeName: "Insurance Receipt",
      number: "IR-0001",
      narration: "Remittance batch 42",
      problems: [],
    });
    expect(byGuid("demo-guid-v5").cancelled).toBe(true);
    expect(byGuid("demo-guid-v6").optional).toBe(true);
    expect(byGuid("demo-guid-v7").postDated).toBe(true);
    expect(byGuid("demo-guid-v7").narration).toBe("PDC to supplier, card 4111111111111111");
    expect(byGuid("demo-guid-v11").narration).toBe("Sublease & parking");
  });

  it("reads entries, skips zero rows, keeps cost centres, bills and foreign currency", () => {
    const v1 = byGuid("demo-guid-v1");
    expect(v1.entries.map((e) => [e.ledger, e.side, e.cents])).toEqual([
      ["Insurer Demo A", "credit", 1_050_000],
      ["Bank - Demo Main", "debit", 1_050_000],
    ]);
    expect(v1.entries[0].bills).toEqual([
      { name: "CLM-DEMO-0001", type: "Agst Ref", cents: 1_050_000 },
    ]);
    const v2 = byGuid("demo-guid-v2");
    expect(v2.entries).toHaveLength(3);
    expect(v2.entries[1].costCentres).toEqual([
      { category: "Branches", name: "Branch Demo North", cents: 60_000 },
      { category: "Branches", name: "Branch Demo South", cents: 40_000 },
    ]);
    expect(byGuid("demo-guid-v3").entries[0].categories).toBe(2);
    expect(byGuid("demo-guid-v4").entries[0]).toMatchObject({
      side: "debit",
      cents: 36_725,
      fx: { amountFx: 100, currency: "USD", rate: 3.6725 },
    });
  });

  it("reads invoice-mode vouchers through the inventory entries' accounting allocations", () => {
    expect(byGuid("demo-guid-v10").entries.map((e) => [e.ledger, e.side, e.cents])).toEqual([
      ["Insurer Demo A", "debit", 52_500],
      ["VAT Output Demo", "credit", 2_500],
      ["Consultation Fees Demo", "credit", 50_000],
    ]);
  });

  it("records a flag that disagrees with the sign as a problem", () => {
    expect(byGuid("demo-guid-v9").problems).toEqual(["sign_mismatch"]);
  });

  it("maps custom voucher types to their base through PARENT, and refuses the rest", () => {
    const parents = new Map(masters().voucherTypes.map((t) => [t.name.toLowerCase(), t.parent]));
    expect(resolveVoucherType("Insurance Receipt", parents)).toBe("receipt");
    expect(resolveVoucherType("Cash Sales", parents)).toBe("sales");
    expect(resolveVoucherType("Credit Note", parents)).toBe("credit_note");
    expect(resolveVoucherType("Memo Demo", parents)).toBeNull();
    expect(resolveVoucherType("Insurance Receipt", new Map())).toBeNull();
  });
});

describe("the dry run (plan)", () => {
  const parsed = mergeParsed([masters(), vouchers()]);
  const plan = planTallyImport(parsed, seededContext());
  const r = plan.report;

  it("maps Tally's predefined groups onto the seeded ones and creates the custom groups under their parent", () => {
    expect(r.groups.predefined).toBe(10);
    expect(r.groups.create).toEqual([
      { name: "Demo Primary Income", parent: null },
      { name: "Insurance Receivables", parent: "Sundry Debtors" },
    ]);
    const dpi = plan.masters.find((m) => m.payload.name === "Demo Primary Income")!;
    expect(dpi.payload).toMatchObject({ parent: null, nature: "income", gross: false });
    const ins = plan.masters.find((m) => m.payload.name === "Insurance Receivables")!;
    const deb = plan.masters.find((m) => m.payload.name === "Sundry Debtors")!;
    expect(deb.payload).toMatchObject({ system_code: "G-DEBT" });
    expect(deb.seq).toBeLessThan(ins.seq); // parents first
    expect(r.groups.refused).toEqual([]);
  });

  it("creates the ledgers, links Profit & Loss A/c to retained earnings, and plans the cost centres", () => {
    expect(r.ledgers.create).toBe(10);
    expect(r.ledgers.linkByName).toEqual([{ name: "Profit & Loss A/c", code: "3100" }]);
    expect(r.ledgers.refused).toEqual([]);
    expect(r.costCentres.create).toEqual(["Branch Demo North", "Branch Demo South", "Dr Demo One"]);
    const kinds = plan.masters.map((m) => m.kind);
    expect(kinds.lastIndexOf("group")).toBeLessThan(kinds.indexOf("cost_centre"));
    expect(kinds.lastIndexOf("cost_centre")).toBeLessThan(kinds.indexOf("ledger"));
  });

  it("builds the opening trial balance by group with the zero-check, dated the day before the first month", () => {
    expect(r.opening).toMatchObject({
      date: "2026-06-30",
      debit: 177_000,
      credit: 177_000,
      difference: 0,
      balanced: true,
      lines: 6,
    });
    expect(r.opening.byGroup).toEqual([
      { group: "Capital Account", debit: 0, credit: 100_000 },
      { group: "Current Assets", debit: 177_000, credit: 0 },
      { group: "Current Liabilities", debit: 0, credit: 30_000 },
      { group: "Profit & Loss A/c", debit: 0, credit: 47_000 },
    ]);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual({ costCentresDropped: 1, openingBills: 1, foreignCurrency: 1 });
  });

  it("skips cancelled and optional vouchers, refuses what it cannot post, and stages the rest", () => {
    expect(r.counts).toMatchObject({
      vouchers: 11,
      cancelled: 1,
      optional: 1,
      refused: 2,
      toPost: 7,
      postDated: 1,
    });
    expect(r.refusals.map((x) => [x.guid, x.code])).toEqual([
      ["demo-guid-v8", "type_unknown"],
      ["demo-guid-v9", "sign_mismatch"],
    ]);
    expect(r.voucherTypes.refused).toEqual([{ name: "Memo Demo", count: 1 }]);
    expect(r.firstDate).toBe("2026-07-05");
    expect(r.lastDate).toBe("2026-08-15");
    expect(plan.vouchers.map((v) => v.guid)).toEqual([
      "demo-guid-v1",
      "demo-guid-v2",
      "demo-guid-v3",
      "demo-guid-v4",
      "demo-guid-v10",
      "demo-guid-v11",
      "demo-guid-v7",
    ]);
    expect(r.months).toContainEqual({
      month: "2026-07",
      type: "receipt",
      count: 1,
      amount: 10_500,
    });
  });

  it("stages balanced lines: cost-centre splits, bills as descriptions, foreign currency, masked narrations", () => {
    const get = (g: string) =>
      plan.vouchers.find((v) => v.guid === g)!.payload as {
        type: string;
        narration: string;
        lines: Array<Record<string, unknown>>;
      };
    const v2 = get("demo-guid-v2");
    expect(v2.type).toBe("sales");
    expect(v2.lines).toEqual([
      { ledger: "Cash - Demo", ledger_guid: "demo-guid-led-cash", debit: 1050, credit: 0 },
      {
        ledger: "Consultation Fees Demo",
        ledger_guid: "demo-guid-led-fees",
        debit: 0,
        credit: 600,
        cost_centre: "Branch Demo North",
      },
      {
        ledger: "Consultation Fees Demo",
        ledger_guid: "demo-guid-led-fees",
        debit: 0,
        credit: 400,
        cost_centre: "Branch Demo South",
      },
      { ledger: "VAT Output Demo", ledger_guid: "demo-guid-led-vat", debit: 0, credit: 50 },
    ]);
    const v1 = get("demo-guid-v1");
    expect(v1.narration).toBe("Tally Insurance Receipt IR-0001: Remittance batch 42");
    expect(v1.lines[0]).toMatchObject({ credit: 10500, description: "Agst Ref CLM-DEMO-0001" });
    expect(get("demo-guid-v3").lines).toEqual([
      { ledger: "Rent Demo", ledger_guid: "demo-guid-led-rent", debit: 5000, credit: 0 },
      { ledger: "Bank - Demo Main", ledger_guid: "demo-guid-led-bank", debit: 0, credit: 5000 },
    ]);
    expect(get("demo-guid-v4").lines[0]).toMatchObject({
      debit: 367.25,
      currency: "USD",
      fx_rate: 3.6725,
      amount_fx: 100,
    });
    const v7 = get("demo-guid-v7").narration;
    expect(v7).toContain("Tally Payment PY-0003: PDC to supplier");
    expect(v7).not.toContain("4111111111111111");
    for (const v of plan.vouchers) {
      const lines = (v.payload as { lines: Array<{ debit: number; credit: number }> }).lines;
      const dr = lines.reduce((a, l) => a + Math.round(l.debit * 100), 0);
      const cr = lines.reduce((a, l) => a + Math.round(l.credit * 100), 0);
      expect(dr, String(v.guid)).toBe(cr);
    }
  });

  it("on a re-import: same ALTERID is unchanged, higher is altered (staged again), lower is older (skipped)", () => {
    const again = planTallyImport(
      parsed,
      seededContext({
        tallyJournals: [
          { guid: "demo-guid-v1", version: 101 },
          { guid: "demo-guid-v2", version: 50 },
          { guid: "demo-guid-v3", version: 900 },
        ],
      }),
    );
    expect(again.report.counts).toMatchObject({ unchanged: 1, altered: 1, older: 1, toPost: 5 });
    expect(again.vouchers.map((v) => v.guid)).not.toContain("demo-guid-v1");
    expect(again.vouchers.find((v) => v.guid === "demo-guid-v2")!.alter_id).toBe(102);
  });

  it("links existing accounts by GUID first, then by exact name", () => {
    const ctx = seededContext();
    const accounts = [
      ...ctx.accounts,
      {
        id: "id-bank",
        code: "1150",
        name: "Something else",
        is_group: false,
        is_system: false,
        tally_guid: "demo-guid-led-bank",
        tally_group: null,
        control: "bank",
      },
      {
        id: "id-rent2",
        code: "T-1",
        name: "Rent Demo",
        is_group: false,
        is_system: false,
        tally_guid: null,
        tally_group: null,
        control: null,
      },
    ];
    const p = planTallyImport(parsed, { ...ctx, accounts });
    expect(p.report.ledgers.linkedByGuid).toBe(1);
    expect(p.report.ledgers.linkByName).toContainEqual({ name: "Rent Demo", code: "T-1" });
    expect(p.report.ledgers.create).toBe(8);
  });

  it("refuses opening balances that do not net to zero", () => {
    const bytes = new TextEncoder().encode(
      readFileSync(join(dir, "masters.xml"), "utf8").replace(
        "<OPENINGBALANCE>-2000.00</OPENINGBALANCE>",
        "<OPENINGBALANCE>-2000.01</OPENINGBALANCE>",
      ),
    );
    const p = planTallyImport(mergeParsed([parseTallyXml(bytes), vouchers()]), seededContext());
    expect(p.report.opening.balanced).toBe(false);
    expect(p.report.opening.difference).toBe(0.01);
    expect(p.report.blocking).toContain("opening_unbalanced");
  });

  it("needs an opening date before the first voucher, and the masters to resolve", () => {
    expect(planTallyImport(masters(), seededContext()).report.blocking).toContain(
      "opening_date_needed",
    );
    expect(
      planTallyImport(masters(), seededContext(), { openingDate: "2026-06-30" }).report.blocking,
    ).toEqual([]);
    expect(
      planTallyImport(parsed, seededContext(), { openingDate: "2026-07-31" }).report.blocking,
    ).toContain("opening_after_vouchers");
    // vouchers alone: the custom type and the ledgers are unknown
    const alone = planTallyImport(vouchers(), seededContext());
    expect(alone.report.refusals.find((x) => x.guid === "demo-guid-v1")!.code).toBe("type_unknown");
    expect(alone.report.refusals.find((x) => x.guid === "demo-guid-v3")!.code).toBe(
      "ledger_unknown",
    );
    // a ledger whose group is missing blocks the import
    const orphan = parseTallyXml(
      new TextEncoder().encode(
        '<ENVELOPE><TALLYMESSAGE><LEDGER NAME="Orphan Demo"><GUID>g-o</GUID><PARENT>Nowhere Group</PARENT></LEDGER></TALLYMESSAGE></ENVELOPE>',
      ),
    );
    const o = planTallyImport(orphan, seededContext());
    expect(o.report.ledgers.refused).toEqual([{ name: "Orphan Demo", code: "parent_unknown" }]);
    expect(o.report.blocking).toContain("masters_refused");
  });
});

describe("Tally trial balance file", () => {
  it("finds a two-row header, skips totals and blank rows, and reads Dr and Cr columns", () => {
    const r = parseTrialBalanceTable([
      ["Demo Clinic LLC"],
      ["Particulars", "Closing Balance", ""],
      ["", "Debit", "Credit"],
      ["Bank - Demo Main", "43,132.75", ""],
      ["Owner Capital Demo", "", 100000],
      ["", "", ""],
      ["Grand Total", 1, 1],
    ]);
    expect(r).toEqual({
      ok: true,
      rows: [
        { name: "Bank - Demo Main", debit: 43132.75, credit: 0 },
        { name: "Owner Capital Demo", debit: 0, credit: 100000 },
      ],
      skipped: 2,
    });
  });

  it("refuses a file without the columns, an unreadable amount and a repeated name", () => {
    expect(parseTrialBalanceTable([["Name", "Amount"]])).toEqual({ ok: false, error: "no_header" });
    expect(
      parseTrialBalanceTable([
        ["Ledger", "Debit", "Credit"],
        ["A", "x", ""],
      ]),
    ).toMatchObject({ ok: false, error: "bad_amount" });
    expect(
      parseTrialBalanceTable([
        ["Ledger", "Debit", "Credit"],
        ["A", 1, ""],
        ["a", 2, ""],
      ]),
    ).toMatchObject({ ok: false, error: "duplicate_name" });
  });
});
