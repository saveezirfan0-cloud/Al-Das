import { describe, expect, it } from "vitest";

import {
  dropHeaderArtefact,
  parseBp,
  slug,
  splitList,
  textOrNull,
  toBool,
  toDate,
  toDateTime,
  toInt,
  toNumber,
  toText,
  upperSnake,
} from "../../scripts/import/convert";

describe("Airtable converters", () => {
  it("toText flattens selects, arrays and blanks", () => {
    expect(toText(null)).toBe("");
    expect(toText({ name: " Drugs " })).toBe("Drugs");
    expect(toText(["a", { name: "b" }, ""])).toBe("a, b");
    expect(textOrNull("   ")).toBeNull();
  });

  it("toNumber parses Unite strings and never turns blanks into 0", () => {
    expect(toNumber("36.5 C")).toBe(36.5);
    expect(toNumber("1,234.50")).toBe(1234.5);
    expect(toNumber("")).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("n/a")).toBeNull();
    expect(toNumber(0)).toBe(0);
    expect(toInt("98.6")).toBe(99);
  });

  it("toBool understands checkboxes, Yes/No and absent cells", () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(undefined)).toBe(false);
    expect(toBool("Yes")).toBe(true);
    expect(toBool({ name: "false" })).toBe(false);
    expect(toBool("", true)).toBeNull();
  });

  it("toDate accepts ISO and day-first legacy strings, rejects impossible dates", () => {
    expect(toDate("2026-03-05T10:00:00.000Z")).toBe("2026-03-05");
    expect(toDate("5/3/2026")).toBe("2026-03-05");
    expect(toDate("31/02/2026")).toBeNull();
    expect(toDate("2026-02-30")).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDateTime("2026-03-05T10:00:00+04:00")).toBe("2026-03-05T06:00:00.000Z");
    expect(toDateTime("garbage")).toBeNull();
  });

  it("slug / upperSnake normalise labels", () => {
    expect(slug("GP / Adults")).toBe("gp_adults");
    expect(slug("Confirm exclusion")).toBe("confirm_exclusion");
    expect(upperSnake("Other Services")).toBe("OTHER_SERVICES");
    expect(upperSnake("OTHER SERVICES")).toBe("OTHER_SERVICES");
    expect(upperSnake("  ")).toBeNull();
  });

  it("parseBp splits '92/61' and keeps a bare number as systolic", () => {
    expect(parseBp("92/61")).toEqual([92, 61]);
    expect(parseBp(" 120 / 80 ")).toEqual([120, 80]);
    expect(parseBp("130")).toEqual([130, null]);
    expect(parseBp("")).toEqual([null, null]);
  });

  it("splitList and dropHeaderArtefact", () => {
    expect(splitList("Corticosteroid + Antibiotic")).toEqual(["Corticosteroid", "Antibiotic"]);
    expect(splitList("")).toBeNull();
    expect(dropHeaderArtefact("SOURCE", "source")).toBeNull();
    expect(dropHeaderArtefact("DHA", "SOURCE")).toBe("DHA");
  });
});
