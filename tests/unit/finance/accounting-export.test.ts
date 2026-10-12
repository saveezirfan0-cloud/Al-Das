import { describe, expect, it } from "vitest";

import {
  buildJournal,
  CSV_HEADER,
  parseJournalSource,
  requiredAccounts,
  type AccountMapRow,
} from "@/lib/finance/accounting-export";

import fixture from "./fixtures/phase18-journal.synthetic.json";

const source = parseJournalSource(fixture.source);
const accounts = fixture.accounts as AccountMapRow[];

describe("accounting export", () => {
  const res = buildJournal(source, accounts, { status: "provisional" });
  it("balances: in total and in every journal", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.debitTotal).toBe(res.creditTotal);
    const byJournal = new Map<string, number>();
    for (const l of res.lines)
      byJournal.set(
        l.journal,
        (byJournal.get(l.journal) ?? 0) + (l.side === "debit" ? l.cents : -l.cents),
      );
    expect([...byJournal.values()].every((v) => v === 0)).toBe(true);
  });

  it("posts sales to receivable and revenue by category, VAT to its account, and the leftover to rounding", () => {
    if (!res.ok) throw new Error("expected ok");
    const j = res.lines.filter((l) => l.journal === "S-20260903-P-self_pay");
    const get = (code: string, side: string) =>
      j.filter((l) => l.accountCode === code && l.side === side).reduce((a, l) => a + l.cents, 0);
    expect(get("1210", "debit")).toBe(26251); // invoice total
    expect(get("4000", "credit")).toBe(25000);
    expect(get("2200", "credit")).toBe(1250);
    expect(get("5990", "credit")).toBe(1); // 262.51 - (250.00 + 12.50) = 0.01 rounding
    expect(get("5910", "debit")).toBe(1000); // credit note
    expect(get("1210", "credit")).toBe(1000);
  });

  it("books write-offs against the receivable", () => {
    if (!res.ok) throw new Error("expected ok");
    const j = res.lines.filter((l) => l.journal === "S-20260903-P-insurance");
    expect(j.find((l) => l.accountCode === "5900")).toMatchObject({ side: "debit", cents: 2500 });
  });

  it("books receipts to the payment-mode account and refunds the other way", () => {
    if (!res.ok) throw new Error("expected ok");
    const r = res.lines.filter((l) => l.journal === "R-20260903-P-self_pay");
    expect(r.find((l) => l.accountCode === "1010")).toMatchObject({ side: "debit", cents: 10000 });
    const f = res.lines.filter((l) => l.journal === "F-20260904-M-self_pay");
    expect(f.find((l) => l.accountCode === "1210")).toMatchObject({ side: "debit", cents: 2000 });
    expect(f.find((l) => l.accountCode === "1010")).toMatchObject({ side: "credit", cents: 2000 });
  });

  it("is byte-for-byte repeatable and writes a stable header", () => {
    const again = buildJournal(source, accounts, { status: "provisional" });
    if (!res.ok || !again.ok) throw new Error("expected ok");
    expect(again.csv).toBe(res.csv);
    expect(again.checksum).toBe(res.checksum);
    expect(res.csv.split("\r\n")[0]).toBe(CSV_HEADER.join(","));
    expect(res.csv).toContain("PROVISIONAL");
    const final = buildJournal(source, accounts, { status: "final" });
    if (!final.ok) throw new Error("expected ok");
    expect(final.csv).toContain("FINAL");
    expect(final.checksum).not.toBe(res.checksum);
  });

  it("fails closed and lists every unmapped account instead of guessing", () => {
    const partial = accounts.filter(
      (a) => a.kind !== "payment_mode" && !(a.kind === "revenue" && a.key === "Laboratory"),
    );
    const r = buildJournal(source, partial, { status: "provisional" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.unmapped).toEqual(
      expect.arrayContaining([
        { kind: "payment_mode", key: "CARD" },
        { kind: "payment_mode", key: "CASH" },
        { kind: "revenue", key: "Laboratory" },
      ]),
    );
  });

  it("needs the rounding account only when there is a difference", () => {
    const noRounding = accounts.filter((a) => a.kind !== "rounding");
    const r = buildJournal(source, noRounding, { status: "provisional" });
    expect(r.ok).toBe(false);
    const exact = parseJournalSource({
      sales: [
        {
          date: "2026-09-03",
          branch: "P",
          type: "self_pay",
          category: "Consultation",
          net: 100,
          vat: 5,
        },
      ],
      totals: [
        {
          date: "2026-09-03",
          branch: "P",
          type: "self_pay",
          total: 105,
          write_off: 0,
          credit_note: 0,
        },
      ],
      receipts: [],
      refunds: [],
    });
    expect(buildJournal(exact, noRounding, { status: "final" }).ok).toBe(true);
  });

  it("flips the side of a negative amount instead of printing a negative number", () => {
    const neg = parseJournalSource({
      sales: [
        {
          date: "2026-09-03",
          branch: "P",
          type: "self_pay",
          category: "Consultation",
          net: -50,
          vat: 0,
        },
      ],
      totals: [
        {
          date: "2026-09-03",
          branch: "P",
          type: "self_pay",
          total: -50,
          write_off: 0,
          credit_note: 0,
        },
      ],
      receipts: [],
      refunds: [],
    });
    const r = buildJournal(neg, accounts, { status: "final" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.csv).not.toMatch(/,-\d/);
    expect(r.lines.find((l) => l.accountCode === "4000")?.side).toBe("debit");
  });

  it("neutralises spreadsheet formulas in text fields", () => {
    const evil = accounts.map((a) =>
      a.kind === "revenue" && a.key === "Consultation"
        ? { ...a, account_name: '=HYPERLINK("http://x")' }
        : a,
    );
    const r = buildJournal(source, evil, { status: "final" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(r.csv).not.toMatch(/,=HYPERLINK/);
  });

  it("lists what the source needs", () => {
    const need = requiredAccounts(source).map((n) => `${n.kind}:${n.key}`);
    expect(need).toEqual(
      expect.arrayContaining([
        "receivable:insurance",
        "receivable:self_pay",
        "vat_output:*",
        "writeoff:*",
        "credit_note:*",
        "payment_mode:CASH",
      ]),
    );
  });

  it("carries no patient data columns", () => {
    expect(CSV_HEADER.join(" ").toLowerCase()).not.toMatch(/patient|name of|pin|emirates|member/);
  });
});
