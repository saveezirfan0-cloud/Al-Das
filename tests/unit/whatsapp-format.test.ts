import { describe, expect, it } from "vitest";

import { parseWhatsAppFormat } from "@/lib/whatsapp/format";
import { reconcileVariables } from "@/lib/whatsapp/template-builder";

describe("parseWhatsAppFormat", () => {
  it("parses the four styles", () => {
    expect(parseWhatsAppFormat("a *b* _c_ ~d~ ```e```")).toEqual([
      { type: "text", text: "a " },
      { type: "bold", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "strike", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "mono", text: "e" },
    ]);
  });
  it("nests styles and leaves unmatched or glued markers alone", () => {
    expect(parseWhatsAppFormat("*_x_*")).toEqual([
      { type: "bold", children: [{ type: "italic", children: [{ type: "text", text: "x" }] }] },
    ]);
    expect(parseWhatsAppFormat("snake_case_name and 2*3*4")).toEqual([
      { type: "text", text: "snake_case_name and 2*3*4" },
    ]);
    expect(parseWhatsAppFormat("* not bold *")).toEqual([{ type: "text", text: "* not bold *" }]);
    expect(parseWhatsAppFormat("")).toEqual([]);
  });
  it("does not execute markup", () => {
    const nodes = parseWhatsAppFormat("*<img src=x onerror=alert(1)>*");
    expect(JSON.stringify(nodes)).toContain("<img");
    expect(nodes[0].type).toBe("bold");
  });
});

describe("reconcileVariables", () => {
  it("keeps examples and mappings with their variable when one is deleted", () => {
    const r = reconcileVariables(
      "a {{1}} b {{2}} c {{3}} d",
      "a {{1}} b c {{3}} d",
      ["Sara", "Dr X", "Mon"],
      { "body.1": "contact.first_name", "body.2": "contact.last_name", "body.3": "contact.phone" },
    );
    expect(r.text).toBe("a {{1}} b c {{2}} d");
    expect(r.examples).toEqual(["Sara", "Mon"]);
    expect(r.varMap).toEqual({ "body.1": "contact.first_name", "body.2": "contact.phone" });
  });
  it("follows a reordering and starts a new variable with an empty example", () => {
    const r = reconcileVariables("{{1}} x {{2}}", "{{2}} x {{1}} y {{3}}", ["A", "B"], {
      "body.1": "contact.first_name",
    });
    expect(r.text).toBe("{{1}} x {{2}} y {{3}}");
    expect(r.examples).toEqual(["B", "A", ""]);
    expect(r.varMap).toEqual({ "body.2": "contact.first_name" });
  });
  it("leaves other prefixes alone", () => {
    const r = reconcileVariables("{{1}}", "", ["A"], { "body.1": "contact.name", "header.1": "x" });
    expect(r.varMap).toEqual({ "header.1": "x" });
  });
});
