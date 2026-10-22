import { describe, expect, it } from "vitest";

import { renderValues } from "@/lib/recall/engine";
import type { EligibleRow } from "@/lib/recall/types";
import {
  DEFAULT_RECALL_VARIABLE,
  joinRecallVariable,
  label,
  missingRecallVariables,
  parseRecallVariableMap,
  recallBodyKeys,
  RECALL_VARIABLE_SOURCES,
  splitRecallVariable,
} from "@/lib/recall/variables";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const ROW: EligibleRow = {
  org_id: "00000000-0000-4000-8000-000000000001",
  contact_id: "00000000-0000-4000-8000-000000000002",
  segment_key: "hypertension",
  cycle_key: "2026-07-01",
};
const TZ = { timezone: "Asia/Dubai" };

describe("recall template values (docs/49 D16)", () => {
  it("the seeded value reads back as first name, title-cased, with the Patient fallback", () => {
    expect(splitRecallVariable(DEFAULT_RECALL_VARIABLE)).toEqual({
      source: "contact.first_name",
      fallback: "Patient",
      title: true,
    });
    expect(
      joinRecallVariable({ source: "contact.first_name", fallback: "Patient", title: true }),
    ).toBe(DEFAULT_RECALL_VARIABLE);
    expect(joinRecallVariable({ source: "contact.last_name", fallback: "  ", title: false })).toBe(
      "contact.last_name",
    );
    // The earlier seed value still reads back (rows a person saved before D17).
    expect(splitRecallVariable("contact.first_name|default:Patient")).toEqual({
      source: "contact.first_name",
      fallback: "Patient",
      title: false,
    });
  });

  it("the engine renders the seeded value, falling back to Patient for a blank first name", () => {
    const map = { "body.1": DEFAULT_RECALL_VARIABLE };
    expect(
      renderValues(map, { first_name: "Mona", last_name: "Test", full_name: "Mona Test" }, ROW, TZ),
    ).toEqual({ "body.1": "Mona" });
    // Like Make's startcase: "mONA" → "Mona".
    expect(
      renderValues(map, { first_name: "mONA ann", last_name: "", full_name: "" }, ROW, TZ),
    ).toEqual({ "body.1": "Mona Ann" });
    expect(renderValues(map, { first_name: "", last_name: "", full_name: "" }, ROW, TZ)).toEqual({
      "body.1": "Patient",
    });
  });

  it("every offered source is one renderValues fills", () => {
    const row = { ...ROW, doctor_name: "Dr Test" };
    const contact = { first_name: "A", last_name: "B", full_name: "A B" };
    for (const s of RECALL_VARIABLE_SOURCES) {
      expect(renderValues({ "body.1": s.key }, contact, row, TZ)["body.1"]).not.toBe("");
    }
  });

  it("does not offer internal keys or the raw start time", () => {
    const keys = RECALL_VARIABLE_SOURCES.map((s) => s.key) as string[];
    expect(keys).not.toContain("recall.segment");
    expect(keys).not.toContain("recall.cycle");
    expect(keys).not.toContain("appointment.starts_at");
  });

  it("splitRecallVariable refuses values the page cannot edit", () => {
    expect(splitRecallVariable("recall.segment")).toBeNull();
    expect(splitRecallVariable("contact.first_name|upper")).toBeNull();
    expect(splitRecallVariable("contact.first_name|default:A|default:B")).toBeNull();
    expect(splitRecallVariable("contact.first_name|default:A|title")).toBeNull();
    expect(splitRecallVariable("")).toBeNull();
    expect(splitRecallVariable(undefined)).toBeNull();
  });

  it("parseRecallVariableMap accepts known sources on the template's own variables", () => {
    expect(
      parseRecallVariableMap(
        {
          "body.1": { source: "contact.first_name", fallback: "Patient" },
          "body.2": { source: "appointment.doctor_name", fallback: "your doctor" },
        },
        ["body.1", "body.2"],
      ),
    ).toEqual({
      ok: true,
      map: {
        "body.1": "contact.first_name|default:Patient",
        "body.2": "appointment.doctor_name|default:your doctor",
      },
    });
  });

  it("a blank source leaves the variable out", () => {
    expect(parseRecallVariableMap({ "body.1": { source: "" } }, ["body.1"])).toEqual({
      ok: true,
      map: {},
    });
  });

  it("refuses unknown variables, unknown sources and unsafe fallbacks without echoing them", () => {
    const bad = [
      parseRecallVariableMap({ "body.3": { source: "contact.first_name" } }, ["body.1"]),
      parseRecallVariableMap({ "header.1": { source: "contact.first_name" } }, ["header.1"]),
      parseRecallVariableMap({ "body.1": { source: "contact.phone_e164" } }, ["body.1"]),
      parseRecallVariableMap(
        { "body.1": { source: "contact.first_name", fallback: "{contact.phone_e164}" } },
        ["body.1"],
      ),
      parseRecallVariableMap({ "body.1": { source: "contact.first_name", fallback: "a|upper" } }, [
        "body.1",
      ]),
      parseRecallVariableMap(
        { "body.1": { source: "contact.first_name", fallback: "x".repeat(61) } },
        ["body.1"],
      ),
    ];
    for (const r of bad) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).not.toContain("phone_e164");
        expect(r.error).not.toContain("xxxx");
      }
    }
  });

  it("recallBodyKeys lists the message's body variables only", () => {
    const components = [
      { type: "HEADER", format: "TEXT", text: "Hi {{1}}", example: { header_text: ["A"] } },
      { type: "BODY", text: "Dear {{1}}, see {{2}}.", example: { body_text: [["A", "B"]] } },
    ] as unknown as MetaTemplateComponent[];
    expect(recallBodyKeys(templateVariables(components))).toEqual(["body.1", "body.2"]);
  });

  it("missingRecallVariables names what a send would lack", () => {
    expect(
      missingRecallVariables(["body.1", "body.2"], { "body.1": "contact.first_name" }),
    ).toEqual(["body.2"]);
    expect(label("body.2")).toBe("{{2}}");
  });
});
