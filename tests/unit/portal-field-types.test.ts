import { describe, expect, it } from "vitest";

import { displayValue, friendlyDbError, parsePortalInput } from "@/lib/portal/field-types";
import { requirePortalObject } from "@/lib/portal/objects";

const classes = requirePortalObject("ref_medication_classes");
const diagnoses = requirePortalObject("ref_diagnoses");
const meds = requirePortalObject("ref_medications");
const web = requirePortalObject("website_entry_points");

describe("parsePortalInput", () => {
  it("requires required columns on create and reports the first error", () => {
    const r = parsePortalInput(classes, "create", { medication_name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors.unite_local_code).toMatch(/required/i);
      expect(r.fieldErrors.class).toMatch(/required/i);
    }
  });

  it("accepts a valid create payload, trims text and drops unknown / read-only keys", () => {
    const r = parsePortalInput(classes, "create", {
      unite_local_code: "  D123 ",
      class: "antibiotic",
      org_id: "attacker",
      id: "x",
      created_at: "2020-01-01",
      bogus: 1,
    });
    expect(r).toEqual({ ok: true, values: { unite_local_code: "D123", class: "antibiotic" } });
  });

  it("rejects unknown select options", () => {
    const r = parsePortalInput(classes, "create", { unite_local_code: "D1", class: "wizard" });
    expect(r.ok).toBe(false);
  });

  it("treats blank optional values as null and blank required values as errors", () => {
    const ok = parsePortalInput(diagnoses, "update", { short_description: "   " });
    expect(ok).toEqual({ ok: true, values: { short_description: null } });
    const bad = parsePortalInput(classes, "update", { class: "" });
    expect(bad.ok).toBe(false);
  });

  it("update ignores createOnly columns and omits absent keys", () => {
    const r = parsePortalInput(diagnoses, "update", { code: "Z99", chronic: true });
    expect(r).toEqual({ ok: true, values: { chronic: true } });
  });

  it("validates numbers, booleans, dates and uuids", () => {
    expect(parsePortalInput(meds, "update", { package_price: "12.5" })).toEqual({
      ok: true,
      values: { package_price: 12.5 },
    });
    expect(parsePortalInput(meds, "update", { package_price: "abc" }).ok).toBe(false);
    expect(parsePortalInput(meds, "update", { is_ebp: "yes" }).ok).toBe(false);
    expect(parsePortalInput(meds, "update", { source_updated_on: "2026-02-30" }).ok).toBe(false);
    expect(parsePortalInput(meds, "update", { source_updated_on: "2026-02-28" }).ok).toBe(true);
    expect(parsePortalInput(diagnoses, "update", { condition_group_id: "nope" }).ok).toBe(false);
    expect(
      parsePortalInput(diagnoses, "update", {
        condition_group_id: "11111111-1111-4111-8111-111111111111",
      }).ok,
    ).toBe(true);
  });

  it("enforces maxLength and integer-only numbers", () => {
    expect(parsePortalInput(web, "update", { prefill_message: "x".repeat(1001) }).ok).toBe(false);
    const groups = requirePortalObject("ref_condition_groups");
    expect(parsePortalInput(groups, "update", { sort: 1.5 }).ok).toBe(false);
    expect(parsePortalInput(groups, "update", { sort: 20 }).ok).toBe(true);
  });

  it("validates arrays for multi_select", () => {
    expect(parsePortalInput(meds, "update", { all_medicine_types: ["A", "B"] }).ok).toBe(true);
    expect(parsePortalInput(meds, "update", { all_medicine_types: "A" }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parsePortalInput(diagnoses, "create", null).ok).toBe(false);
    expect(parsePortalInput(diagnoses, "create", []).ok).toBe(false);
  });
});

describe("displayValue / friendlyDbError", () => {
  it("renders select labels, booleans and arrays", () => {
    const cls = classes.columns.find((c) => c.key === "class")!;
    expect(displayValue(cls, "antibiotic")).toBe("Antibiotic");
    const bool = diagnoses.columns.find((c) => c.key === "chronic")!;
    expect(displayValue(bool, true)).toBe("Yes");
    expect(displayValue(bool, null)).toBe("");
    const arr = meds.columns.find((c) => c.key === "all_medicine_types")!;
    expect(displayValue(arr, ["A", "B"])).toBe("A; B");
  });

  it("maps database errors without leaking internals", () => {
    expect(
      friendlyDbError({ code: "23505", message: "dup key value violates unique constraint foo" }),
    ).not.toMatch(/foo/);
    expect(
      friendlyDbError({
        code: "23514",
        message: 'violates check constraint "approved_requires_signature"',
      }),
    ).toMatch(/signature/);
    expect(friendlyDbError({ code: "XX000" })).toBe("Could not save the record.");
  });
});
