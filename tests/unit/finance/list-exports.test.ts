/**
 * Phase G: list exports (pure parts): the filters the Claims and Denials downloads read, the query string that carries
 * a list's filters to its download, and the workbook writer (plain values, never formulas).
 */
import { describe, expect, it } from "vitest";

import { cellValue, filePart, sheetName, tableWorkbook } from "@/lib/export/table-xlsx";
import {
  EXPORT_MAX_ROWS,
  exportQuery,
  parseClaimFilters,
  parseDenialFilters,
  truncatedLine,
} from "@/lib/finance/list-exports";

describe("list filters", () => {
  it("reads the claims filters like the page, without PostgREST grammar characters", () => {
    expect(
      parseClaimFilters({ q: "CL(1),%*", status: "Paid", match: "ambiguous", page: "3" }),
    ).toEqual({
      q: "CL 1",
      status: "Paid",
      payer: "",
      denial: "",
      match: "ambiguous",
      cstatus: null,
    });
    expect(parseClaimFilters({ match: "everything" }).match).toBeNull();
    expect(parseClaimFilters({ cstatus: "taken_back" }).cstatus).toBe("taken_back");
    expect(parseClaimFilters({ cstatus: "approved" }).cstatus).toBeNull();
  });

  it("reads the denials filters: active cases by default, every status on request", () => {
    expect(parseDenialFilters({})).toMatchObject({ status: "active", mine: false, due: false });
    expect(parseDenialFilters({ status: "all", mine: "1", due: "1" })).toMatchObject({
      status: "all",
      mine: true,
      due: true,
    });
    expect(parseDenialFilters({ status: "won" }).status).toBe("won");
    expect(parseDenialFilters({ status: "drop table" }).status).toBe("active");
  });

  it("carries only the named filters to the download, never the page number", () => {
    expect(exportQuery({ q: "A1", page: "4", other: "x" }, ["q", "status"])).toBe("?q=A1");
    expect(exportQuery({}, ["q"])).toBe("");
    expect(truncatedLine(false)).toEqual([]);
    expect(truncatedLine(true)[0]).toContain(EXPORT_MAX_ROWS.toLocaleString("en-GB"));
  });
});

describe("table workbook", () => {
  it("writes numbers in number columns and everything else as text", () => {
    expect(cellValue("12.50", "money")).toBe(12.5);
    expect(cellValue("", "money")).toBe("");
    expect(cellValue("=SUM(A1)", "text")).toBe("=SUM(A1)");
    expect(cellValue(null, "text")).toBeNull();
    expect(sheetName("Day/book: [x]?")).toBe("Day book   x");
    expect(filePart("ledger 1100/Cash")).toBe("ledger-1100-Cash");
  });

  it("stores a typed formula as a string, never as a formula", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const buf = await tableWorkbook({
      org: "Synthetic Clinic",
      builtAt: "2026-10-14T08:00:00.000Z",
      sheet: "Invoices",
      title: "Finance invoices",
      columns: [{ header: "Invoice" }, { header: "Total", kind: "money" }],
      rows: [
        ['=HYPERLINK("http://x")', "100.25"],
        ["SYN-2", 5],
      ],
      totals: ["Total", 105.25],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values: unknown[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => values.push(c.value)));
    expect(values).toContain('=HYPERLINK("http://x")');
    expect(values).toContain(100.25);
    expect(values.some((v) => typeof v === "object" && v !== null && "formula" in v)).toBe(false);
  });
});
