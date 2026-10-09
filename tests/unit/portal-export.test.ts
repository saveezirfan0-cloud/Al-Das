import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/csv";
import { exportColumns, portalRowsToCsv } from "@/lib/portal/export";
import { requirePortalObject } from "@/lib/portal/objects";

const diag = requirePortalObject("ref_diagnoses");

describe("portal CSV export", () => {
  const rows = [
    {
      id: "1",
      code: "I10",
      short_description: '=HYPERLINK("http://x")',
      chronic: true,
      condition_group_id: "g1",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "2",
      code: "J45",
      short_description: "Asthma, mild",
      chronic: false,
      condition_group_id: null,
      created_at: null,
    },
  ];

  it("exports labels as headers, booleans as Yes/No and link titles", () => {
    const csv = portalRowsToCsv(diag, rows, {
      columns: ["code", "short_description", "chronic", "condition_group_id"],
      linkTitles: { condition_group_id: { g1: "Hypertension" } },
    });
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["Code", "Short description", "Chronic", "Condition group"]);
    expect(parsed.rows[0][2]).toBe("Yes");
    expect(parsed.rows[0][3]).toBe("Hypertension");
    expect(parsed.rows[1][1]).toBe("Asthma, mild");
    expect(parsed.rows[1][3]).toBe("");
  });

  it("neutralises spreadsheet formulas", () => {
    const csv = portalRowsToCsv(diag, rows, { columns: ["short_description"] });
    expect(parseCsv(csv).rows[0][0].startsWith("=")).toBe(false);
  });

  it("ignores unknown requested columns", () => {
    expect(exportColumns(diag, ["code", "org_id"]).map((c) => c.key)).toEqual(["code"]);
  });
});
