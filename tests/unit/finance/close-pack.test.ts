import { describe, expect, it } from "vitest";

import {
  buildClosePack,
  monthLabel,
  packDrift,
  readClosePack,
  type ClosePackInput,
  type MonthFigures,
} from "@/lib/finance/close-pack";
import { closePackPdf, toWinAnsi } from "@/lib/finance/close-pdf";
import { closePackXlsx, type SignOff } from "@/lib/finance/close-xlsx";

import fixture from "./fixtures/phase18-close.synthetic.json";

const input = fixture as unknown as ClosePackInput;
const pack = buildClosePack(input);
const signed: SignOff = {
  financeBy: "Fiona Finance",
  financeAt: "2026-10-03T08:00:00Z",
  financeNote: "Reviewed",
  ceoBy: "Carl Chief",
  ceoAt: "2026-10-04T09:00:00Z",
  ceoNote: null,
  lockedAt: "2026-10-04T09:00:00Z",
  hash: "a".repeat(64),
};
const unsigned: SignOff = {
  financeBy: null,
  financeAt: null,
  financeNote: null,
  ceoBy: null,
  ceoAt: null,
  ceoNote: null,
  lockedAt: null,
  hash: null,
};

describe("buildClosePack", () => {
  it("adds the branches into the totals", () => {
    expect(pack.totals).toMatchObject({
      generated: 62000.5,
      invoices: 400,
      claimed: 49000,
      remitted: 38000,
      rejected: 3900,
      outstanding: 7100,
      claims: 350,
      self_pay_collected: 13000.25,
      collected: 48000.25,
      refunds: 200,
      revenue_net: 62000.5,
    });
  });
  it("is plain data: nothing but aggregates and a doctor's name", () => {
    const json = JSON.stringify(pack);
    expect(json).not.toMatch(/pin|emirates|member|phone|birth/i);
    expect(readClosePack(JSON.parse(json))).not.toBeNull();
  });
  it("is deterministic for the same input", () => {
    expect(JSON.stringify(buildClosePack(input))).toBe(JSON.stringify(pack));
  });
  it("refuses a stored value that is not a v1 pack", () => {
    expect(readClosePack(null)).toBeNull();
    expect(readClosePack({ version: 2 })).toBeNull();
    expect(readClosePack({ version: 1, month: "2026-09-01" })).toBeNull();
  });
  it("labels the month", () => {
    expect(monthLabel("2026-09-01")).toBe("September 2026");
  });
});

describe("packDrift (a locked month versus the live mirror)", () => {
  const live = JSON.parse(JSON.stringify(fixture.figures)) as MonthFigures;
  it("is empty when nothing changed", () => {
    expect(packDrift(pack, live, 62000.5)).toEqual([]);
  });
  it("shows an amended invoice and a late payment", () => {
    live.by_branch[1].generated += 250;
    live.collections[0].paid += 75.5;
    const drift = packDrift(pack, live, 62250.5);
    expect(drift).toEqual(
      expect.arrayContaining([
        { metric: "generated", frozen: 62000.5, live: 62250.5, difference: 250 },
        { metric: "collected", frozen: 48000.25, live: 48075.75, difference: 75.5 },
        { metric: "revenue_net", frozen: 62000.5, live: 62250.5, difference: 250 },
      ]),
    );
    expect(drift.find((d) => d.metric === "claimed")).toBeUndefined();
  });
  it("ignores a difference below one cent", () => {
    const l2 = JSON.parse(JSON.stringify(fixture.figures)) as MonthFigures;
    l2.by_branch[0].generated += 0.004;
    expect(packDrift(pack, l2, 62000.5)).toEqual([]);
  });
});

describe("XLSX", () => {
  it("writes every sheet from the frozen pack, values only, and is repeatable", async () => {
    const a = await closePackXlsx(pack, signed);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(a as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Controls",
      "By branch",
      "Revenue by category",
      "Revenue by department",
      "Revenue by doctor",
      "Collections",
      "Receivables ageing",
      "Denials",
      "Cash-up",
    ]);
    const summary = wb.getWorksheet("Summary")!;
    const flat: string[] = [];
    summary.eachRow((r) => flat.push(r.values?.toString() ?? ""));
    const text = flat.join("\n");
    expect(text).toContain("September 2026");
    expect(text).toContain("LOCKED");
    expect(text).toContain("Fiona Finance");
    expect(text).toContain("a".repeat(64));
    const branches = wb.getWorksheet("By branch")!;
    expect(branches.getRow(2).getCell(1).value).toBe("G");
    expect(branches.getRow(4).getCell(2).value).toBe(30000);
    // no formulas anywhere
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((c) =>
          expect(
            typeof c.value === "object" && c.value && "formula" in (c.value as object),
          ).toBeFalsy(),
        ),
      ),
    );
  });
  it("says so when the month is not signed", async () => {
    const wb = new (await import("exceljs")).default.Workbook();
    await wb.xlsx.load((await closePackXlsx(pack, unsigned)) as never);
    const flat: string[] = [];
    wb.getWorksheet("Summary")!.eachRow((r) => flat.push(String(r.values)));
    expect(flat.join("\n")).toContain("Not signed off");
  });
});

describe("PDF", () => {
  it("renders a real PDF whose text carries the month, the status, the figures and the fingerprint", async () => {
    const bytes = await closePackPdf(pack, signed);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    expect(totalPages).toBeGreaterThanOrEqual(1);
    const all = Array.isArray(text) ? text.join("\n") : text;
    expect(all).toContain("September 2026");
    expect(all).toContain("LOCKED");
    expect(all).toContain("62,000.50");
    expect(all).toContain("Dr Test One");
    expect(all).toContain("a".repeat(64));
    expect(all).toMatch(/page 1 of \d/);
  });
  it("paginates a long pack instead of running off the page", async () => {
    const big = buildClosePack({
      ...input,
      revenue: {
        ...input.revenue,
        by_doctor: Array.from({ length: 50 }, (_, i) => ({
          key: `DHA-${i}`,
          label: `Dr Synthetic ${i}`,
          net: 1000 + i,
          invoices: 10,
        })),
      },
    });
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await closePackPdf(big, unsigned));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
  it("replaces characters Helvetica cannot draw instead of failing", async () => {
    expect(toWinAnsi("Dr محمد – “ok”")).toBe('Dr ???? - "ok"');
    const odd = buildClosePack({
      ...input,
      revenue: { ...input.revenue, by_doctor: [{ key: "X", label: "محمد", net: 1, invoices: 1 }] },
    });
    await expect(closePackPdf(odd, unsigned)).resolves.toBeInstanceOf(Buffer);
  });
});
