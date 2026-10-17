import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkRange,
  LOAD_CHUNK_SIZE,
  LoadExportError,
  monthTotals,
  rawRowFor,
  readSavedExport,
} from "@/lib/finance/load-export";
import { mapInvoice } from "@/lib/finance/map-invoice";

import { rawInvoice } from "./factory";

const file = (v: unknown) => Buffer.from(JSON.stringify(v));
const invoices = (n: number) =>
  Array.from({ length: n }, (_, i) => rawInvoice({ InvDisplayNumber: `ADMC/C/${80000 + i}` }));

describe("readSavedExport", () => {
  it("keeps every record exactly as received and the envelope's status fields", () => {
    const data = invoices(3);
    const out = readSavedExport(
      file({ MessageStatus: "Success", DataBalancetoSync: 7, Data: data }),
    );
    expect(out.records).toBe(3);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].payload).toEqual({
      MessageStatus: "Success",
      DataBalancetoSync: 7,
      Data: data,
    });
  });

  it("accepts a bare array of invoices", () => {
    const out = readSavedExport(file(invoices(2)));
    expect(out.chunks[0].payload).toEqual({ Data: invoices(2) });
  });

  it("splits into batches of 500 in file order, and is repeatable", () => {
    const data = invoices(LOAD_CHUNK_SIZE * 2 + 1);
    const a = readSavedExport(file({ Data: data }));
    const b = readSavedExport(file({ Data: data }));
    expect(a.chunks.map((c) => c.records)).toEqual([500, 500, 1]);
    expect((a.chunks[2].payload.Data as unknown[])[0]).toEqual(data[1000]);
    expect(a.chunks.map((c) => c.sha256)).toEqual(b.chunks.map((c) => c.sha256));
    expect(new Set(a.chunks.map((c) => c.sha256)).size).toBe(3);
    expect(a.fileSha256).toBe(b.fileSha256);
  });

  it("an empty list is one empty batch", () => {
    const out = readSavedExport(file({ Data: [] }));
    expect(out.records).toBe(0);
    expect(out.chunks).toHaveLength(1);
  });

  it("refuses what it cannot trust, without echoing the file", () => {
    const secret = "Test Patient One";
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from(`not json ${secret}`),
      file({ rows: [] }),
      file("text"),
      file(null),
      file({ Data: [{ InvDisplayNumber: "" }, { PatientName: secret }] }),
    ];
    for (const c of cases) {
      let message = "";
      try {
        readSavedExport(c);
      } catch (e) {
        expect(e).toBeInstanceOf(LoadExportError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("strips a byte order mark", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), file({ Data: invoices(1) })]);
    expect(readSavedExport(bom).records).toBe(1);
  });
});

describe("checkRange", () => {
  it("wants real dates in order", () => {
    expect(() => checkRange("2026-01-01", "2026-01-31")).not.toThrow();
    expect(() => checkRange("2026-01-01", "2026-01-01")).not.toThrow();
    expect(() => checkRange("01-01-2026", "2026-01-31")).toThrow(LoadExportError);
    expect(() => checkRange("2026-02-30x", "2026-03-01")).toThrow(LoadExportError);
    expect(() => checkRange("2026-02-01", "2026-01-31")).toThrow(LoadExportError);
    expect(() => checkRange("", "")).toThrow(LoadExportError);
  });
});

describe("rawRowFor", () => {
  it("builds the raw row without a file name or live-pull balances", () => {
    const out = readSavedExport(file({ DataBalancetoSync: 9, Data: invoices(2) }));
    const row = rawRowFor(out.chunks[0], out.fileSha256, 1, 1, {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(row).toMatchObject({
      from_date: "2026-01-01",
      to_date: "2026-01-31",
      count_requested: 2,
      http_status: 200,
      record_count: 2,
      balance_in_range: null,
      balance_overall: null,
      payload_sha256: out.chunks[0].sha256,
    });
    expect(row.detail_message).toBe(`saved export ${out.fileSha256.slice(0, 12)} part 1/1`);
    expect(row.payload).toBe(out.chunks[0].payload);
  });

  it("an empty batch still satisfies count_requested > 0", () => {
    const out = readSavedExport(file({ Data: [] }));
    expect(
      rawRowFor(out.chunks[0], out.fileSha256, 1, 1, { from: "a", to: "b" }).count_requested,
    ).toBe(1);
  });
});

describe("monthTotals", () => {
  const inv = (n: string, date: string, extra = {}) =>
    rawInvoice({ InvDisplayNumber: n, TransactionDate: date, ...extra });

  it("sums invoice totals per month from the mapped values, newest version of a re-sent invoice only", () => {
    const a = inv("T/1", "02-03-2026");
    const b = inv("T/2", "15-03-2026");
    const c = inv("T/3", "01-04-2026");
    const total = (r: Record<string, unknown>) => Math.round(mapInvoice(r).total * 100);
    const out = readSavedExport(file({ Data: [a, b, c, a] }));
    expect(monthTotals(out.chunks)).toEqual([
      { month: "2026-03", invoices: 2, totalCents: total(a) + total(b) },
      { month: "2026-04", invoices: 1, totalCents: total(c) },
    ]);
  });
});

describe("never calls Unite", () => {
  it("neither the module nor the script imports the Unite client", () => {
    for (const f of ["lib/finance/load-export.ts", "scripts/finance-load-export.ts"]) {
      const src = readFileSync(join(__dirname, "../../..", f), "utf8");
      expect(src).not.toMatch(/lib\/unite|financeDetails|createUniteClient|UNITE_/);
    }
  });
});
