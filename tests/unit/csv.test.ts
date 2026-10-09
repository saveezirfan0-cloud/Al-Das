import { describe, expect, it } from "vitest";

import { csvEscape, csvToObjects, parseCsv, toCsv } from "@/lib/csv";

describe("csv", () => {
  it("parses quotes, embedded commas/newlines, CRLF and a BOM", () => {
    const text =
      '﻿Name,Phone,Note\r\n"Doe, Jane",+971500000001,"line1\nline2"\r\nBob,+971500000002,"He said ""hi"""\r\n\r\n';
    const csv = parseCsv(text);
    expect(csv.headers).toEqual(["Name", "Phone", "Note"]);
    expect(csv.rows).toEqual([
      ["Doe, Jane", "+971500000001", "line1\nline2"],
      ["Bob", "+971500000002", 'He said "hi"'],
    ]);
    expect(csvToObjects(csv)[0]).toEqual({
      Name: "Doe, Jane",
      Phone: "+971500000001",
      Note: "line1\nline2",
    });
  });

  it("handles a file without a trailing newline and short rows", () => {
    const csv = parseCsv("a,b,c\n1,2\n3,4,5");
    expect(csv.rows).toEqual([
      ["1", "2"],
      ["3", "4", "5"],
    ]);
    expect(csvToObjects(csv)[0]).toEqual({ a: "1", b: "2", c: "" });
  });

  it("supports other delimiters", () => {
    expect(parseCsv("a;b\n1;2", ";").rows).toEqual([["1", "2"]]);
  });

  it("escapes on output and neutralises formula injection", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a "q", b')).toBe('"a ""q"", b"');
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape(["a", "b"])).toBe("a; b");
    expect(csvEscape(null)).toBe("");
    const out = toCsv(["x", "y"], [["1", "2"]]);
    expect(out).toBe("﻿x,y\r\n1,2\r\n");
    expect(parseCsv(out).rows).toEqual([["1", "2"]]);
  });
});
