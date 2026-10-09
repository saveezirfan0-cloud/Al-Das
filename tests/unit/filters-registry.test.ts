import { describe, expect, it } from "vitest";

import {
  buildContactFieldRegistry,
  OPERATORS_BY_TYPE,
  OPERATOR_LABELS,
  operatorAllowed,
  UnknownFieldError,
} from "@/lib/filters/field-registry";
import { OPERATORS } from "@/lib/filters/ast";

describe("contact field registry", () => {
  const registry = buildContactFieldRegistry({
    customFields: [
      {
        key: "insurance_plan",
        label: "Insurance plan",
        type: "select",
        options: [{ value: "axa", label: "AXA" }],
      },
      { key: "visits", label: "Visits", type: "number" },
      { key: "Bad Key", label: "ignored", type: "text" },
    ],
  });

  it("exposes base fields, custom fields and hides relations whose tables do not exist yet", () => {
    expect(registry.get("full_name")?.available).toBe(true);
    expect(registry.get("tags")?.available).toBe(true);
    expect(registry.get("mentioned_user")?.available).toBe(true);
    expect(registry.get("enquiry_stage")?.available).toBe(false);
    expect(registry.get("appointment_count")?.available).toBe(true); // Phase 6 table
    expect(registry.get("appointment_status")?.available).toBe(true);
    expect(() => registry.require("enquiry_stage")).toThrow(UnknownFieldError);
    expect(() => registry.require("nope")).toThrow(UnknownFieldError);
  });

  it("registers custom fields under custom.<key> with their type", () => {
    const cf = registry.get("custom.insurance_plan");
    expect(cf?.type).toBe("select");
    expect(cf?.options?.[0].value).toBe("axa");
    expect(cf?.group).toBe("Custom fields");
    expect(registry.get("custom.visits")?.type).toBe("number");
    expect(registry.get("custom.Bad Key")).toBeUndefined();
  });

  it("can make later relations available", () => {
    const later = buildContactFieldRegistry({
      availableRelations: ["contact_tags", "enquiries", "appointments"],
    });
    expect(later.get("enquiry_stage")?.available).toBe(true);
    expect(later.get("mentioned_user")?.available).toBe(false);
  });

  it("maps every operator to a label and every type to operators", () => {
    for (const op of OPERATORS) expect(OPERATOR_LABELS[op]).toBeTruthy();
    for (const ops of Object.values(OPERATORS_BY_TYPE)) expect(ops.length).toBeGreaterThan(0);
    expect(operatorAllowed(registry.require("gender"), "eq")).toBe(true);
    expect(operatorAllowed(registry.require("gender"), "contains")).toBe(false);
    expect(operatorAllowed(registry.require("birthday"), "within_next")).toBe(true);
    expect(operatorAllowed(registry.require("stop_marketing"), "eq")).toBe(false);
  });
});
