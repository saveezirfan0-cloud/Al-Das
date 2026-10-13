/**
 * Slice 20E: the lab and referral reconciliation rules (pure). Synthetic data only: PINs like SYN-001, doctors like
 * DHA-SYN-1, codes are real CPT shapes. Matching both ways, the CPT mapping, the date window, ambiguity (never guessed),
 * the fixed-fee allocation, price variances, turnaround, the review blockers and determinism.
 */
import { describe, expect, it } from "vitest";

import {
  chargeKindFor,
  fileKindFor,
  lineKey,
  maskPin,
  parseTestList,
  reconcileStatement,
  shareByWeight,
  statementFigures,
  uniteKey,
  type ProviderLine,
  type StatementInput,
  type UniteLine,
} from "@/lib/finance/labs";

const line = (id: string, over: Partial<ProviderLine> = {}): ProviderLine => ({
  id,
  serviceDate: "2026-10-05",
  code: "85025",
  pin: "SYN-001",
  doctor: null,
  branch: null,
  resultDate: null,
  amount: null,
  ...over,
});
const unite = (id: string, over: Partial<UniteLine> = {}): UniteLine => ({
  id,
  invoiceId: `inv-${id}`,
  pin: "SYN-001",
  date: "2026-10-05",
  itemCode: "85025",
  lineCpt: null,
  refCpt: null,
  net: 50,
  branch: "P",
  doctor: "DHA-SYN-1",
  ...over,
});
const input = (over: Partial<StatementInput> = {}): StatementInput => ({
  provider: { id: "prov", kind: "send_out_lab", fixedFee: null, basis: "test_count" },
  month: "2026-10-01",
  lines: [],
  unite: [],
  tests: [],
  notes: [],
  settings: { windowDays: 2, priceTolerance: 1 },
  today: "2026-11-05",
  ...over,
});

describe("matching", () => {
  it("pairs a line with the only Unite line of the same PIN, code and day, with score and reasons", () => {
    const r = reconcileStatement(
      input({ lines: [line("l1", { doctor: "DHA-SYN-1" })], unite: [unite("u1")] }),
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].unite.id).toBe("u1");
    expect(r.matched[0].score).toBe(100);
    expect(r.matched[0].reasons).toEqual([
      "Same Unite PIN",
      "Same item code",
      "Same day",
      "Same doctor",
    ]);
    expect(r.notBilled).toEqual([]);
  });

  it("matches the code through the line's CPT or the CPT of the Unite item in reference data", () => {
    const r = reconcileStatement(
      input({
        lines: [line("l1"), line("l2", { pin: "SYN-002", code: "80053" })],
        unite: [
          unite("u1", { itemCode: "LAB-CBC", lineCpt: "85025" }),
          unite("u2", { pin: "SYN-002", itemCode: "LAB-CMP", refCpt: "80053" }),
        ],
      }),
    );
    expect(r.matched.map((m) => [m.line.id, m.unite.id, m.reasons[1]])).toEqual([
      ["l1", "u1", "Same CPT code"],
      ["l2", "u2", "CPT of the Unite item (reference data)"],
    ]);
  });

  it("compares PIN and code ignoring case and spaces", () => {
    const r = reconcileStatement(
      input({ lines: [line("l1", { pin: "syn-001 ", code: " 85025" })], unite: [unite("u1")] }),
    );
    expect(r.matched).toHaveLength(1);
  });

  it("uses the date window from the settings, inclusive, and lowers the score per day", () => {
    const lines = [line("l1", { serviceDate: "2026-10-03" })];
    const two = reconcileStatement(input({ lines, unite: [unite("u1", { date: "2026-10-05" })] }));
    expect(two.matched).toHaveLength(1);
    expect(two.matched[0].score).toBe(70);
    expect(two.matched[0].reasons).toContain("2 day(s) apart");
    const three = reconcileStatement(
      input({ lines, unite: [unite("u1", { date: "2026-10-06" })] }),
    );
    expect(three.matched).toHaveLength(0);
    expect(three.notBilled[0].why).toBe("no_candidate");
    const zero = reconcileStatement(
      input({
        lines,
        unite: [unite("u1", { date: "2026-10-04" })],
        settings: { windowDays: 0, priceTolerance: 1 },
      }),
    );
    expect(zero.matched).toHaveLength(0);
  });

  it("never guesses: two Unite lines that fit one line (or two lines one Unite line) are ambiguous", () => {
    const twoUnite = reconcileStatement(
      input({ lines: [line("l1")], unite: [unite("u1"), unite("u2")] }),
    );
    expect(twoUnite.matched).toEqual([]);
    expect(twoUnite.notBilled[0]).toMatchObject({ why: "ambiguous", candidates: 2 });
    const twoLines = reconcileStatement(
      input({ lines: [line("l1"), line("l2")], unite: [unite("u1")] }),
    );
    expect(twoLines.matched).toEqual([]);
    expect(twoLines.notBilled.map((n) => n.why)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("pairs same-day candidates first, so a visit two days later does not make it ambiguous", () => {
    const r = reconcileStatement(
      input({
        lines: [
          line("l1", { serviceDate: "2026-10-05" }),
          line("l2", { serviceDate: "2026-10-07" }),
        ],
        unite: [unite("u1", { date: "2026-10-05" }), unite("u2", { date: "2026-10-07" })],
      }),
    );
    expect(r.matched.map((m) => [m.line.id, m.unite.id])).toEqual([
      ["l1", "u1"],
      ["l2", "u2"],
    ]);
  });

  it("a line without a PIN is never matched", () => {
    const r = reconcileStatement(
      input({ lines: [line("l1", { pin: null })], unite: [unite("u1", { pin: null })] }),
    );
    expect(r.matched).toEqual([]);
    expect(r.notBilled[0].why).toBe("no_pin");
  });

  it("notes a doctor mismatch without refusing the pair", () => {
    const r = reconcileStatement(
      input({ lines: [line("l1", { doctor: "DHA-SYN-9" })], unite: [unite("u1")] }),
    );
    expect(r.matched[0].score).toBe(90);
    expect(r.matched[0].reasons.at(-1)).toBe("Doctor differs (file DHA-SYN-9, Unite DHA-SYN-1)");
  });
});

describe("leakage both ways", () => {
  it("done but not billed: on the file with nothing in Unite", () => {
    const r = reconcileStatement(
      input({ lines: [line("l1", { code: "84443" })], unite: [unite("u1")] }),
    );
    expect(r.notBilled.map((n) => [n.key, n.why])).toEqual([[lineKey("l1"), "no_candidate"]]);
  });

  it("billed but not on the file: send-out labs, the provider's own codes, Unite lines of the month only", () => {
    const tests = [{ code: "85025", expectedDays: 2, agreedPrice: null }];
    const u = [
      unite("u-oct", { pin: "SYN-009" }),
      unite("u-sep", { pin: "SYN-009", date: "2026-09-30" }),
      unite("u-other-code", { pin: "SYN-009", itemCode: "99213" }),
      unite("u-cpt", { pin: "SYN-010", itemCode: "LAB-X", refCpt: "85025" }),
    ];
    const r = reconcileStatement(
      input({ lines: [line("l1", { pin: "SYN-001" })], unite: u, tests }),
    );
    // sorted by date, then id
    expect(r.notOnFile.map((n) => n.key)).toEqual([uniteKey("u-cpt"), uniteKey("u-oct")]);
    for (const kind of ["in_house_lab", "hospital", "radiology", "other"] as const)
      expect(
        reconcileStatement(
          input({
            provider: { id: "p", kind, fixedFee: 100, basis: "test_count" },
            unite: u,
            tests,
          }),
        ).notOnFile,
        kind,
      ).toEqual([]);
  });

  it("a Unite line that is a candidate of an ambiguous line is not also listed as missing from the file", () => {
    const tests = [{ code: "85025", expectedDays: null, agreedPrice: 10 }];
    const r = reconcileStatement(
      input({ lines: [line("l1"), line("l2")], unite: [unite("u1")], tests }),
    );
    expect(r.notOnFile).toEqual([]);
  });
});

describe("price variances", () => {
  it("lists lines further than the tolerance from the agreed price", () => {
    const tests = [{ code: "85025", expectedDays: null, agreedPrice: 35 }];
    const r = reconcileStatement(
      input({
        lines: [
          line("a", { amount: 36 }),
          line("b", { amount: 36.01 }),
          line("c", { amount: 30 }),
          line("d"),
        ],
        tests,
      }),
    );
    expect(r.priceVariances.map((v) => [v.line.id, v.diff])).toEqual([
      ["b", 1.01],
      ["c", -5],
    ]);
  });
});

describe("turnaround", () => {
  it("late results, results still waiting past the expected days, and on-time results", () => {
    const tests = [{ code: "85025", expectedDays: 2, agreedPrice: null }];
    const r = reconcileStatement(
      input({
        today: "2026-10-10",
        tests,
        lines: [
          line("on-time", { resultDate: "2026-10-07" }),
          line("late", { resultDate: "2026-10-08" }),
          line("waiting", { serviceDate: "2026-10-09" }),
          line("waiting-late", { serviceDate: "2026-10-01" }),
          line("no-expectation", { code: "84443", resultDate: "2026-10-30" }),
        ],
      }),
    );
    expect(r.turnaround.withExpectation).toBe(4);
    expect(r.turnaround.onTime).toBe(1);
    expect(r.turnaround.late.map((l) => [l.line.id, l.days, l.pending])).toEqual([
      ["waiting-late", 9, true],
      ["late", 3, false],
    ]);
  });
});

describe("cost by doctor and branch", () => {
  it("invoice amounts per doctor and branch: the Unite doctor of a matched test, else the file's doctor", () => {
    const r = reconcileStatement(
      input({
        lines: [
          line("l1", { amount: 40, doctor: "DHA-SYN-9", branch: "G" }),
          line("l2", { pin: "SYN-002", amount: 25.5, doctor: "dha-syn-2" }),
          line("l3", { pin: null, amount: 10 }),
        ],
        unite: [unite("u1")],
      }),
    );
    expect(r.allocation).toEqual([
      { doctor: "DHA-SYN-1", branch: "G", tests: 1, cost: 40 },
      { doctor: "DHA-SYN-2", branch: null, tests: 1, cost: 25.5 },
      { doctor: null, branch: null, tests: 1, cost: 10 },
    ]);
    expect(r.doctors).toEqual([
      { doctor_dha_id: "DHA-SYN-1", amount: 40 },
      { doctor_dha_id: "DHA-SYN-2", amount: 25.5 },
    ]);
    expect(r.summary).toMatchObject({ totalCost: 75.5, allocated: 65.5, unallocated: 10 });
  });

  it("the in-house lab's fixed fee is shared by test count, adding up to the fee exactly", () => {
    const lines = [
      line("a", { doctor: "DHA-SYN-1", pin: null }),
      line("b", { doctor: "DHA-SYN-2", pin: null }),
      line("c", { doctor: "DHA-SYN-3", pin: null }),
    ];
    const r = reconcileStatement(
      input({
        provider: { id: "p", kind: "in_house_lab", fixedFee: 25000, basis: "test_count" },
        lines,
      }),
    );
    expect(r.allocation.map((a) => a.cost)).toEqual([8333.34, 8333.33, 8333.33]);
    expect(r.summary.totalCost).toBe(25000);
  });

  it("by revenue: the matched tests' billed net decides the share", () => {
    const r = reconcileStatement(
      input({
        provider: { id: "p", kind: "in_house_lab", fixedFee: 1000, basis: "revenue" },
        lines: [
          line("l1"),
          line("l2", { pin: "SYN-002" }),
          line("l3", { pin: null, doctor: "DHA-SYN-3" }),
        ],
        unite: [
          unite("u1", { net: 300 }),
          unite("u2", { pin: "SYN-002", net: 100, doctor: "DHA-SYN-2" }),
        ],
      }),
    );
    expect(r.doctors).toEqual([
      { doctor_dha_id: "DHA-SYN-1", amount: 750 },
      { doctor_dha_id: "DHA-SYN-2", amount: 250 },
    ]);
  });

  it("refuses the review without the in-house fee, or with no revenue to share it by", () => {
    const lines = [line("l1", { pin: null, doctor: "DHA-SYN-1" })];
    const notes = [{ itemKey: lineKey("l1"), code: "checked_by_hand", note: null }];
    expect(
      reconcileStatement(
        input({
          provider: { id: "p", kind: "in_house_lab", fixedFee: null, basis: "test_count" },
          lines,
          notes,
        }),
      ).problems,
    ).toEqual(["Set the in-house lab's monthly fee in the settings."]);
    expect(
      reconcileStatement(
        input({
          provider: { id: "p", kind: "in_house_lab", fixedFee: 500, basis: "revenue" },
          lines,
          notes,
        }),
      ).problems,
    ).toEqual([
      "No billed revenue to share the fee by; match the lines or share it by test count.",
    ]);
  });

  it("largest remainder: ties go to the earlier row and the total is exact", () => {
    expect(shareByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(shareByWeight(2_500_000, [7, 0, 3])).toEqual([1_750_000, 0, 750_000]);
    expect(shareByWeight(100, [0, 0])).toEqual([0, 0]);
    const s = shareByWeight(99_999, [3, 5, 7, 11]);
    expect(s.reduce((a, c) => a + c, 0)).toBe(99_999);
  });
});

describe("review blockers and figures", () => {
  it("every unmatched line and every billed test missing from the file needs a reason", () => {
    const tests = [{ code: "85025", expectedDays: null, agreedPrice: 10 }];
    const base = input({
      lines: [line("l1", { code: "84443", amount: 5 })],
      unite: [unite("u1", { pin: "SYN-002" })],
      tests,
    });
    expect(reconcileStatement(base).problems).toEqual([
      "1 line(s) not matched to Unite need a reason.",
      "1 billed test(s) missing from the file need a reason.",
    ]);
    const done = reconcileStatement({
      ...base,
      notes: [
        { itemKey: lineKey("l1"), code: "billing_to_correct", note: null },
        { itemKey: uniteKey("u1"), code: "provider_error", note: null },
      ],
    });
    expect(done.problems).toEqual([]);
    expect(reconcileStatement(input()).problems).toEqual(["Upload the provider's file first."]);
  });

  it("is deterministic whatever the input order, and the figures carry ids, codes and amounts only", () => {
    const lines = [line("l2", { pin: "SYN-002", amount: 5 }), line("l1", { amount: 7 })];
    const u = [unite("u2", { pin: "SYN-002" }), unite("u1")];
    const a = reconcileStatement(input({ lines, unite: u }));
    const b = reconcileStatement(input({ lines: [...lines].reverse(), unite: [...u].reverse() }));
    expect(a).toEqual(b);
    const f = statementFigures(a, {
      statementId: "s",
      providerId: "prov",
      providerKind: "send_out_lab",
      month: "2026-10-01",
    });
    expect(f).toMatchObject({ version: "labs-1", charge_kind: "lab", problems: [] });
    expect(f.matched).toEqual([
      { line: "l1", unite: "u1", score: 90 },
      { line: "l2", unite: "u2", score: 90 },
    ]);
    expect(JSON.stringify(f)).not.toMatch(/SYN-00/); // no PIN in the frozen figures
  });

  it("file and charge kinds per provider kind", () => {
    expect(fileKindFor("in_house_lab")).toBe("lab_activity");
    expect(fileKindFor("radiology")).toBe("provider_invoice");
    expect(chargeKindFor("send_out_lab")).toBe("lab");
    expect(chargeKindFor("hospital")).toBe("referral");
  });
});

describe("helpers", () => {
  it("masks the PIN to its last three characters", () => {
    expect(maskPin("SYN-12345")).toBe("•••345");
    expect(maskPin("AB")).toBe("•••");
    expect(maskPin(null)).toBe("-");
  });

  it("parses a test list and refuses bad lines with the line number", () => {
    expect(parseTestList("85025, 1, 35\n80053;2;\n84443\t\t120.50")).toEqual({
      ok: true,
      rows: [
        { code: "85025", expectedDays: 1, agreedPrice: 35 },
        { code: "80053", expectedDays: 2, agreedPrice: null },
        { code: "84443", expectedDays: null, agreedPrice: 120.5 },
      ],
    });
    for (const [raw, msg] of [
      ["", "Enter at least one test."],
      ["John Smith, 1, 2", "Line 1: the code is not a CPT or item code."],
      ["85025, 1.5", "Line 1: expected days must be a whole number from 0 to 365."],
      ["85025, , 1.234", "Line 1: the agreed price"],
      ["85025, 1\n85025, 2", "Line 2: 85025 appears twice."],
      ["85025", "Line 1: give the expected days, the agreed price, or both."],
    ] as const) {
      const r = parseTestList(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error).toContain(msg);
    }
  });
});
