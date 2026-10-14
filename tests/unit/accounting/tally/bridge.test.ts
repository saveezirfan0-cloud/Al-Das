/**
 * Phase 22J: the Tally bridge's pure parts. REMOTEID determinism, tokens and pairing codes, the voucher built from a
 * journal (ledger mapping, holds, sign convention through lib/finance/tally-xml.ts), the daily summary, Tally's import
 * answers, the trial balance from ledger closing balances, the job allow-list. Synthetic data only ("Demo Clinic").
 */
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { checkImportXml } from "@/connector/tally-bridge/lib/validate.mjs";
import {
  bearerToken,
  capturedJournal,
  connectorCode,
  DEFAULT_PUSH_SOURCES,
  generateDeviceToken,
  generatePairingCode,
  hashSecret,
  isDeviceToken,
  isJobKind,
  isPulseRemoteId,
  JOB_KINDS,
  journalBranch,
  journalSha256,
  normalisePairingCode,
  PUSH_SOURCES,
  remoteIdBase,
  resolveVoucher,
  summariseDay,
  swapSides,
  TALLY_BRIDGE_TYPES,
  tallyTypeFor,
  voucherNumberFor,
  withPulseVoucherTypes,
  type MappingContext,
  type PulseJournal,
} from "@/lib/accounting/tally/bridge";
import { decodeParts, ResultError } from "@/lib/accounting/tally/bridge-server";
import { parseTallyXml } from "@/lib/accounting/tally/parse";
import { resolveVoucherType } from "@/lib/accounting/tally/plan";
import {
  importVerdict,
  parseImportResponse,
  trialBalanceRows,
} from "@/lib/accounting/tally/response";
import { buildBridgeVoucherXml } from "@/lib/finance/tally-xml";

const ORG = "0f3c2b1a-1111-4222-8333-444455556666";
const enc = (s: string) => new TextEncoder().encode(s);

const ctx: MappingContext = {
  accounts: [
    {
      id: "a-bank",
      code: "1150",
      name: "Bank - Demo Main",
      tally_guid: "g-bank",
      tally_name: null,
      is_group: false,
    },
    {
      id: "a-sup",
      code: "2100",
      name: "Trade payables",
      tally_guid: "g-sup",
      tally_name: "Supplier Demo B",
      is_group: false,
    },
    {
      id: "a-rev",
      code: "4100",
      name: "Consultation Fees Demo",
      tally_guid: "g-rev",
      tally_name: null,
      is_group: false,
    },
    {
      id: "a-rec",
      code: "1200",
      name: "Insurance receivable",
      tally_guid: "g-rec",
      tally_name: "Insurer Demo A",
      is_group: false,
    },
    {
      id: "a-vat",
      code: "2200",
      name: "VAT output",
      tally_guid: "g-vat",
      tally_name: null,
      is_group: false,
    },
    {
      id: "a-card",
      code: "1300",
      name: "Card clearing",
      tally_guid: null,
      tally_name: null,
      is_group: false,
    },
    {
      id: "a-grp",
      code: "G-BANK",
      name: "Bank Accounts",
      tally_guid: "g-grp",
      tally_name: null,
      is_group: true,
    },
  ],
  costCentres: new Map([["cc-1", "Dr Demo One"]]),
  branchCostCentres: new Map([["N", "Branch Demo North"]]),
};

const payment: PulseJournal = {
  date: "2026-07-15",
  voucherType: "payment",
  narration: "Payment voucher PV-DEMO-1",
  lines: [
    { account_code: "2100", debit: 2500, credit: 0 },
    { account_code: "1150", debit: 0, credit: 2500 },
  ],
};

describe("identities", () => {
  it("REMOTEID base: deterministic, Pulse-prefixed, short; ids that could collide are hashed", () => {
    const a = remoteIdBase(ORG, "voucher", "11111111-2222-4333-8444-555566667777");
    expect(a).toBe("pulse-0f3c2b1a111142228333444455556666-pv-11111111222243338444555566667777");
    expect(remoteIdBase(ORG, "voucher", "11111111-2222-4333-8444-555566667777")).toBe(a);
    expect(remoteIdBase(ORG, "unite_invoice_day", "2026-07-15|N")).toBe(
      "pulse-0f3c2b1a111142228333444455556666-uid-20260715N",
    );
    expect(remoteIdBase(ORG, "unite_invoice", "INV001")).toMatch(/-ui-INV001$/);
    const slash = remoteIdBase(ORG, "unite_invoice", "INV/2026/001");
    const dash = remoteIdBase(ORG, "unite_invoice", "INV-2026-001");
    expect(slash).not.toBe(dash);
    expect(slash).toMatch(/-ui-h[0-9a-f]{32}$/);
    expect(
      remoteIdBase(ORG, "fixed_asset", "11111111-2222-4333-8444-555566667777:reverse"),
    ).toMatch(/-fa-h[0-9a-f]{32}$/);
    for (const id of [a, slash, remoteIdBase(ORG, "voucher", "x".repeat(200))]) {
      expect(id.length).toBeLessThanOrEqual(83);
      expect(isPulseRemoteId(`${id}-99999-r`)).toBe(true);
    }
    expect(() => remoteIdBase("not-an-org", "voucher", "1")).toThrow();
    expect(isPulseRemoteId("demo-guid-v1")).toBe(false);
  });

  it("voucher numbers are stable per REMOTEID and a reversal is marked", () => {
    expect(voucherNumberFor(`${remoteIdBase(ORG, "voucher", "a")}-1`)).toMatch(/^PB-[0-9A-F]{10}$/);
    expect(voucherNumberFor("pulse-x-1")).toBe(voucherNumberFor("pulse-x-1"));
    expect(voucherNumberFor("pulse-x-1-r")).toMatch(/-R$/);
    expect(voucherNumberFor("pulse-x-1")).not.toBe(voucherNumberFor("pulse-x-2"));
  });

  it("device tokens are 256 bits with a prefix; pairing codes are typed forgivingly", () => {
    const t = generateDeviceToken();
    expect(isDeviceToken(t)).toBe(true);
    expect(generateDeviceToken()).not.toBe(t);
    expect(hashSecret(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`Basic ${t}`)).toBeNull();
    expect(bearerToken("Bearer ptb_short")).toBeNull();
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-HJ-NP-TV-Z2-9]{4}(-[A-HJ-NP-TV-Z2-9]{4}){3}$/);
    expect(normalisePairingCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(normalisePairingCode("ABC")).toBeNull();
    expect(normalisePairingCode("O0O0-1111-IIII-LLLL")).toBeNull();
  });
});

describe("the voucher for a journal", () => {
  it("maps accounts to Tally ledgers (the pulled Tally name first) with debits first", () => {
    const r = resolveVoucher(payment, ctx);
    expect(r).toMatchObject({ action: "push", amount: 2500, voucherType: "payment" });
    if (r.action !== "push") return;
    expect(r.content).toEqual({
      narration: "Pulse: Payment voucher PV-DEMO-1",
      entries: [
        { ledger: "Supplier Demo B", side: "debit", cents: 250_000 },
        { ledger: "Bank - Demo Main", side: "credit", cents: 250_000 },
      ],
    });
  });

  it("holds, never guesses: an account without a Tally ledger, an unknown account, a group, unbalanced lines", () => {
    const unmapped = resolveVoucher(
      {
        ...payment,
        lines: [
          { account_code: "1300", debit: 10 },
          { account_code: "1150", credit: 10 },
        ],
      },
      ctx,
    );
    expect(unmapped).toMatchObject({
      action: "hold",
      reason: "ledger_unmapped",
      detail: "No Tally ledger for: 1300 Card clearing",
    });
    expect(
      resolveVoucher(
        {
          ...payment,
          lines: [
            { account_code: "9999", debit: 10 },
            { account_code: "1150", credit: 10 },
          ],
        },
        ctx,
      ),
    ).toMatchObject({ action: "hold", reason: "account_unknown" });
    expect(
      resolveVoucher(
        {
          ...payment,
          lines: [
            { account_id: "a-grp", debit: 10 },
            { account_code: "1150", credit: 10 },
          ],
        },
        ctx,
      ),
    ).toMatchObject({ action: "hold", reason: "account_unknown" });
    expect(
      resolveVoucher(
        {
          ...payment,
          lines: [
            { account_code: "2100", debit: 10 },
            { account_code: "1150", credit: 9 },
          ],
        },
        ctx,
      ),
    ).toMatchObject({ action: "hold", reason: "unbalanced" });
    expect(resolveVoucher({ ...payment, lines: [] }, ctx)).toEqual({ action: "nothing" });
    expect(resolveVoucher({ ...payment, voucherType: "opening" }, ctx)).toMatchObject({
      reason: "voucher_type",
    });
  });

  it("the fingerprint follows the journal, not the mapping or the line order", () => {
    const flipped = { ...payment, lines: [...payment.lines].reverse() };
    expect(journalSha256(flipped)).toBe(journalSha256(payment));
    expect(journalSha256({ ...payment, date: "2026-07-16" })).not.toBe(journalSha256(payment));
    const renamed = { ...ctx, accounts: ctx.accounts.map((a) => ({ ...a, tally_name: null })) };
    const a = resolveVoucher(payment, ctx);
    const b = resolveVoucher(payment, renamed);
    expect(a.action === "push" && b.action === "push" && a.journalSha256 === b.journalSha256).toBe(
      true,
    );
  });

  it("cost centres: the line's own, else the branch's Tally cost centre, else none", () => {
    const r = resolveVoucher(
      {
        ...payment,
        voucherType: "journal",
        lines: [
          { account_code: "4100", credit: 60, cost_centre_id: "cc-1" },
          { account_code: "4100", credit: 40, branch_code: "N" },
          { account_code: "1150", debit: 100, branch_code: "S" },
        ],
      },
      ctx,
    );
    expect(r.action === "push" && r.content.entries).toEqual([
      { ledger: "Bank - Demo Main", side: "debit", cents: 10_000 },
      {
        ledger: "Consultation Fees Demo",
        side: "credit",
        cents: 4_000,
        cost_centre: "Branch Demo North",
      },
      {
        ledger: "Consultation Fees Demo",
        side: "credit",
        cents: 6_000,
        cost_centre: "Dr Demo One",
      },
    ]);
  });

  it("is written with Tally's sign convention, a Pulse REMOTEID and GUID, and parses back to the same entries", () => {
    const r = resolveVoucher(payment, ctx);
    if (r.action !== "push") throw new Error("expected push");
    const remote = `${remoteIdBase(ORG, "voucher", "a1")}-1`;
    const xml = buildBridgeVoucherXml({
      company: "Demo Clinic LLC",
      costCategory: "Primary Cost Category",
      remoteId: remote,
      number: voucherNumberFor(remote),
      date: "2026-07-15",
      tallyType: tallyTypeFor("payment")!,
      narration: r.content.narration,
      entries: r.content.entries,
    });
    expect(xml).toContain(`<VOUCHER REMOTEID="${remote}" VCHTYPE="Pulse Payment" ACTION="Create"`);
    expect(xml).toContain(`<GUID>${remote}</GUID>`);
    expect(xml).toMatch(
      /<LEDGERNAME>Supplier Demo B<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>-2500\.00<\/AMOUNT>/,
    );
    expect(xml).toMatch(
      /<LEDGERNAME>Bank - Demo Main<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>2500\.00<\/AMOUNT>/,
    );
    expect(xml).not.toMatch(/delete/i);
    const back = parseTallyXml(enc(xml)).vouchers[0];
    expect(back).toMatchObject({
      guid: remote,
      remoteId: remote,
      date: "2026-07-15",
      typeName: "Pulse Payment",
      problems: [],
    });
    expect(back.entries.map((e) => [e.ledger, e.side, e.cents])).toEqual([
      ["Supplier Demo B", "debit", 250_000],
      ["Bank - Demo Main", "credit", 250_000],
    ]);
    // the connector accepts exactly this, and refuses it for another id
    expect(checkImportXml(xml, remote)).toBeNull();
    expect(checkImportXml(xml, `${remote}0`)).toBe("not_pulse_voucher");
    // the same input, the same bytes
    expect(
      buildBridgeVoucherXml({
        company: "Demo Clinic LLC",
        costCategory: "Primary Cost Category",
        remoteId: remote,
        number: voucherNumberFor(remote),
        date: "2026-07-15",
        tallyType: "Pulse Payment",
        narration: r.content.narration,
        entries: r.content.entries,
      }),
    ).toBe(xml);
  });

  it("refuses to write an unbalanced voucher or one that is not Pulse's", () => {
    const base = {
      company: null,
      costCategory: "Primary Cost Category",
      remoteId: "pulse-abc-1",
      number: "PB-1",
      date: "2026-07-15",
      tallyType: "Pulse Journal",
      narration: "x",
    };
    expect(() =>
      buildBridgeVoucherXml({
        ...base,
        entries: [
          { ledger: "A", side: "debit", cents: 100 },
          { ledger: "B", side: "credit", cents: 90 },
        ],
      }),
    ).toThrow(/unbalanced/);
    expect(() =>
      buildBridgeVoucherXml({
        ...base,
        remoteId: "demo-guid-1",
        entries: [
          { ledger: "A", side: "debit", cents: 100 },
          { ledger: "B", side: "credit", cents: 100 },
        ],
      }),
    ).toThrow(/Pulse/);
  });

  it("a pushed voucher's type resolves to its base when it comes back, even if Tally did not list the type", () => {
    const parsed = withPulseVoucherTypes(parseTallyXml(enc("<ENVELOPE></ENVELOPE>")));
    const parents = new Map(parsed.voucherTypes.map((t) => [t.name.toLowerCase(), t.parent]));
    for (const [base, name] of Object.entries(TALLY_BRIDGE_TYPES))
      expect(resolveVoucherType(name, parents)).toBe(base);
    // a type Tally lists keeps Tally's parent
    const listed = withPulseVoucherTypes({
      ...parsed,
      voucherTypes: [{ name: "Pulse Journal", guid: "g", parent: "Contra" }],
    });
    expect(listed.voucherTypes.filter((t) => t.name === "Pulse Journal")).toEqual([
      { name: "Pulse Journal", guid: "g", parent: "Contra" },
    ]);
  });
});

describe("daily revenue summary (OQ-124)", () => {
  const inv = (rev: number, vat: number, branch: string, account = "4100"): PulseJournal => ({
    date: "2026-07-15",
    voucherType: "sales",
    narration: "Unite invoice",
    lines: [
      { account_code: "1200", debit: rev + vat },
      { account_code: account, credit: rev, branch_code: branch },
      { account_code: "2200", credit: vat },
    ],
  });

  it("nets the day's invoices per account and branch into one balanced voucher", () => {
    const j = summariseDay([inv(100, 5, "N"), inv(200, 10, "N")], {
      date: "2026-07-15",
      branch: "N",
      kind: "unite_invoice_day",
    });
    expect(j).toMatchObject({
      date: "2026-07-15",
      voucherType: "sales",
      narration: "Unite invoices 2026-07-15 branch N (2 items)",
    });
    const r = resolveVoucher(j, ctx);
    expect(r.action === "push" && r.content.entries).toEqual([
      { ledger: "Insurer Demo A", side: "debit", cents: 31_500 },
      {
        ledger: "Consultation Fees Demo",
        side: "credit",
        cents: 30_000,
        cost_centre: "Branch Demo North",
      },
      { ledger: "VAT output", side: "credit", cents: 1_500 },
    ]);
    expect(
      summariseDay([], { date: "2026-07-15", branch: "N", kind: "unite_payment_day" }).voucherType,
    ).toBe("receipt");
  });

  it("finds a journal's branch from its lines", () => {
    expect(journalBranch(inv(1, 0, "s"))).toBe("S");
    expect(journalBranch(payment)).toBe("ALL");
  });
});

describe("helpers", () => {
  it("swaps sides for a reversing accrual's own reversal", () => {
    const s = swapSides(payment, "2026-08-01", "Reversal");
    expect(s.lines).toEqual([
      { account_code: "2100", debit: 0, credit: 2500 },
      { account_code: "1150", debit: 2500, credit: 0 },
    ]);
    expect(s.date).toBe("2026-08-01");
  });

  it("reads a captured journal and refuses anything else", () => {
    expect(
      capturedJournal({
        date: "2026-07-20",
        voucher_type: "contra",
        narration: "Float top-up",
        lines: [{ account_id: "a", debit: 75, credit: 0, branch_code: "N" }],
      }),
    ).toEqual({
      date: "2026-07-20",
      voucherType: "contra",
      narration: "Float top-up",
      lines: [{ account_id: "a", debit: 75, credit: 0, branch_code: "N", cost_centre_id: null }],
    });
    expect(capturedJournal({ error: "invalid" })).toBeNull();
    expect(capturedJournal(null)).toBeNull();
  });

  it("the job allow-list has four kinds and no delete; unknown connector codes become 'error'", () => {
    expect([...JOB_KINDS].sort()).toEqual([
      "export_masters_since",
      "export_trial_balance",
      "export_vouchers_since",
      "import_voucher",
    ]);
    expect(isJobKind("delete_voucher")).toBe(false);
    expect(isJobKind("import_voucher")).toBe(true);
    expect(connectorCode("tally_unreachable")).toBe("tally_unreachable");
    expect(connectorCode("<script>")).toBe("error");
    expect(DEFAULT_PUSH_SOURCES.every((s) => (PUSH_SOURCES as readonly string[]).includes(s))).toBe(
      true,
    );
  });

  it("decodes the connector's parts (gzip, base64) within the caps", () => {
    const part = gzipSync(Buffer.from("<RESPONSE><CREATED>1</CREATED></RESPONSE>")).toString(
      "base64",
    );
    expect(new TextDecoder().decode(decodeParts([part])[0])).toBe(
      "<RESPONSE><CREATED>1</CREATED></RESPONSE>",
    );
    expect(decodeParts(undefined)).toEqual([]);
    expect(() => decodeParts(["not base64!"])).toThrow(ResultError);
    expect(() => decodeParts([Buffer.from("plain").toString("base64")])).toThrow(ResultError);
    expect(() => decodeParts(Array(9).fill(part))).toThrow(ResultError);
  });
});

describe("Tally's answers", () => {
  it("an import: created or altered with LASTVCHID; errors and LINEERROR fail; anything else is unreadable", () => {
    const ok = parseImportResponse(
      enc(
        "<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><LASTVCHID>123</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>",
      ),
    );
    expect(importVerdict(ok)).toEqual({ outcome: "created", masterId: 123 });
    expect(
      importVerdict(
        parseImportResponse(
          enc("<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS></RESPONSE>"),
        ),
      ),
    ).toEqual({
      outcome: "altered",
      masterId: null,
    });
    const wrapped = parseImportResponse(
      enc(
        "<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>7</LASTVCHID></IMPORTRESULT></DATA></BODY></ENVELOPE>",
      ),
    );
    expect(importVerdict(wrapped)).toEqual({ outcome: "created", masterId: 7 });
    const refused = parseImportResponse(
      enc(
        "<RESPONSE><LINEERROR>Voucher Type &apos;Pulse Payment&apos; does not exist!</LINEERROR><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS></RESPONSE>",
      ),
    );
    expect(importVerdict(refused)).toEqual({
      outcome: "failed",
      code: "tally_error",
      message: "Voucher Type 'Pulse Payment' does not exist!",
    });
    expect(
      importVerdict(
        parseImportResponse(enc("<RESPONSE><CREATED>2</CREATED><ERRORS>0</ERRORS></RESPONSE>")),
      ),
    ).toMatchObject({
      outcome: "failed",
    });
    expect(importVerdict(parseImportResponse(enc("TallyPrime Server is Running")))).toEqual({
      outcome: "ambiguous",
      code: "unreadable_answer",
    });
    expect(importVerdict(parseImportResponse(new Uint8Array(0)))).toMatchObject({
      outcome: "ambiguous",
    });
  });

  it("reads a UTF-16 answer the same way", () => {
    const text =
      "<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>5</LASTVCHID></RESPONSE>";
    const le = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff;
    le[1] = 0xfe;
    for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
    expect(importVerdict(parseImportResponse(le))).toEqual({ outcome: "created", masterId: 5 });
  });

  it("the trial balance: ledger closing balances (negative = debit) as rows, zero balances left out", () => {
    const parsed = parseTallyXml(
      enc(`<ENVELOPE><BODY><DATA><COLLECTION>
        <LEDGER NAME="Bank - Demo Main"><CLOSINGBALANCE>-52500.00</CLOSINGBALANCE></LEDGER>
        <LEDGER NAME="Supplier Demo B"><CLOSINGBALANCE>27500.00</CLOSINGBALANCE></LEDGER>
        <LEDGER NAME="Cash - Demo"><CLOSINGBALANCE></CLOSINGBALANCE></LEDGER>
        <LEDGER NAME="Suspense Demo"><CLOSINGBALANCE>0.00</CLOSINGBALANCE></LEDGER>
      </COLLECTION></DATA></BODY></ENVELOPE>`),
    );
    expect(parsed.ledgers.find((l) => l.name === "Cash - Demo")!.closingDrMinusCr).toBeNull();
    expect(trialBalanceRows(parsed)).toEqual([
      { name: "Bank - Demo Main", debit: 52500, credit: 0 },
      { name: "Supplier Demo B", debit: 0, credit: 27500 },
    ]);
  });
});
