import { describe, expect, it } from "vitest";

import { buildCollections, parseCollectionsInputs } from "@/lib/finance/collections";
import { collectionsWorkbook } from "@/lib/finance/collections-xlsx";

import fixture from "./fixtures/phase23-collections.synthetic.json";

describe("collections workbook", () => {
  it("has Daily, Branches, Doctors, Data quality and Definitions with Pulse's values and no formulas", async () => {
    const report = buildCollections(
      parseCollectionsInputs({
        month: "2026-09-01",
        branch: null,
        coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
        settings: { late_invoice_days: 3 },
        ...fixture.expected,
      }),
    );
    const buf = await collectionsWorkbook({
      org: "Synthetic Clinic",
      report,
      branchLabel: "All branches",
      branchNames: { PJ: "Synthetic Palm", GM: "Synthetic Mile" },
      builtAt: "2026-10-14T06:00:00.000Z",
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Daily",
      "Branches",
      "Doctors",
      "Data quality",
      "Definitions",
    ]);

    let formulas = 0;
    for (const ws of wb.worksheets)
      ws.eachRow((r) =>
        r.eachCell((c) => {
          if (
            c.formula ||
            (typeof c.value === "object" && c.value !== null && "formula" in c.value)
          )
            formulas++;
        }),
      );
    expect(formulas).toBe(0);

    const rows = (name: string) => {
      const out: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
      return out;
    };
    const find = (name: string, first: unknown) => rows(name).find((r) => r[0] === first);

    // Daily: Date, Rows, Cash, Card, Bank transfer, Payment gateway, Other payment, Total collected, ..., Net billing
    expect(find("Daily", "2026-09-01")?.slice(0, 8)).toEqual([
      "2026-09-01",
      3,
      210,
      535,
      0,
      0,
      0,
      745,
    ]);
    const total = find("Daily", "Total")!;
    expect(total[1]).toBe(14);
    expect(total[7]).toBe(1940.555);
    expect(total[10]).toBe(3700.555);
    expect(
      rows("Daily")
        .flat()
        .some((v) => typeof v === "string" && v.includes("difference -290.00")),
    ).toBe(true);

    expect(find("Branches", "Synthetic Mile")?.[1]).toBe("GM");
    expect(find("Branches", "Unknown branch (clinic not mapped)")?.[2]).toBe(2);
    expect(find("Branches", "Invoice type not recognised")?.[1]).toBe("CORPORATE");
    expect(find("Doctors", "Dr Demo-01")?.slice(1, 3)).toEqual([5, 1630]);
    expect(find("Data quality", "Late invoices")?.slice(1, 4)).toEqual([
      2,
      380,
      "Invoices raised more than 3 days after the visit.",
    ]);
    expect(find("Data quality", "Synthetic Clinic Unmapped")?.slice(1, 3)).toEqual([1, 250]);
    expect(find("Data quality", "(blank clinic)")?.slice(1, 3)).toEqual([1, 40]);
    expect(rows("Definitions").flat()).toContain("Total collected");

    // no PIN, patient ref or invoice number anywhere
    const all = JSON.stringify(wb.worksheets.map((w) => rows(w.name)));
    expect(all).not.toMatch(/9000000\d\d|P-syn|S-\d\d|I-\d\d/);
  });
});
