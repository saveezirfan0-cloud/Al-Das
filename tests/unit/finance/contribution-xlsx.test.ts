import { describe, expect, it } from "vitest";

import { buildContribution, parseContributionInputs } from "@/lib/finance/contribution";
import { contributionWorkbook } from "@/lib/finance/contribution-xlsx";

import fixture from "./fixtures/m2a-contribution.synthetic.json";

async function load(canSeePay: boolean) {
  const report = buildContribution(parseContributionInputs(structuredClone(fixture.expected)), {
    canSeePay,
    branchNames: { P: "Palm", M: "Marina" },
  });
  const buf = await contributionWorkbook({
    org: "Synthetic Clinic",
    report,
    branchLabel: "All branches",
    builtAt: "2026-10-14T06:00:00.000Z",
  });
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const rows = (name: string) => {
    const out: unknown[][] = [];
    wb.getWorksheet(name)!.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
    return out;
  };
  return { wb, rows };
}

describe("contribution workbook", () => {
  it("has Contribution and Definitions, plain values, Provisional named, the allocated line apart", async () => {
    const { wb, rows } = await load(true);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Contribution", "Definitions"]);
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

    const sheet = rows("Contribution");
    expect(String(sheet[2][0])).toMatch(/^Provisional: /);
    const head = sheet.find((r) => r[0] === "Level")!;
    expect(head).toContain("Doctor pay");
    const doc = sheet.find((r) => r[0] === "Doctor" && r[3] === "Dr Demo-01" && r[1] === "Palm")!;
    expect(doc.slice(5)).toEqual([6000, "Pay loaded", 4000, 200, 1800]);
    const unlinked = sheet.find((r) => r[3] === "Dr Demo-04")!;
    expect(unlinked[6]).toBe("Pay not linked");
    const palmLines = sheet.filter((r) => r[1] === "Palm" && String(r[0]).match(/L5|L6|allocated/));
    expect(palmLines.map((r) => [r[0], r[r.length - 1]])).toEqual([
      ["Clinic contribution (L5)", 2800],
      ["Less shared overhead allocated", -6950],
      ["After allocation (L6)", -4150],
    ]);
    // no PIN anywhere
    const all = JSON.stringify(sheet) + JSON.stringify(rows("Definitions"));
    expect(all).not.toMatch(/9000000\d\d/);
  });

  it("without the compensation permission the file has no pay column and no individual pay", async () => {
    const { rows } = await load(false);
    const sheet = rows("Contribution");
    expect(sheet.find((r) => r[0] === "Level")).not.toContain("Doctor pay");
    const values = new Set(sheet.flat().filter((v) => typeof v === "number"));
    for (const v of [4000, 1333.333, 666.667, 1800, 7000, 10000])
      expect(values.has(v), String(v)).toBe(false);
    const doc = sheet.find((r) => r[0] === "Doctor" && r[3] === "Dr Demo-01" && r[1] === "Palm")!;
    expect(doc.slice(5)).toEqual([6000, "Pay loaded", 200, ""]); // contribution cell left empty
    const marina = sheet.find((r) => r[0] === "Clinic contribution (L5)" && r[1] === "Marina")!;
    expect(marina[marina.length - 1]).toBe("Withheld");
    const palm = sheet.find((r) => r[0] === "Clinic contribution (L5)" && r[1] === "Palm")!;
    expect(palm[palm.length - 1]).toBe(2800);
  });
});
