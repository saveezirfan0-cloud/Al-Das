import { describe, expect, it } from "vitest";

import { ParamBag } from "@/lib/filters/to-sql";
import {
  BULK_EDIT_MAX,
  bulkEditableColumns,
  bulkResult,
  bulkResultMessage,
  bulkTagSchema,
  diffTagSets,
  planBulkEdit,
  tagRowsToAdd,
} from "@/lib/portal/bulk-edit";
import { buildPortalFieldRegistry } from "@/lib/portal/filter-registry";
import { PORTAL_OBJECTS, requirePortalObject } from "@/lib/portal/objects";
import { compilePortalPredicate, compilePortalTagFilter } from "@/lib/portal/query";

const diag = requirePortalObject("ref_diagnoses");
const entries = requirePortalObject("website_entry_points");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";

describe("bulkEditableColumns", () => {
  it("offers the single-edit columns minus create-only, read-only and the title column", () => {
    for (const o of PORTAL_OBJECTS) {
      const keys = bulkEditableColumns(o).map((c) => c.key);
      expect(keys, o.key).not.toContain(o.titleColumn);
      for (const c of o.columns) {
        if (c.readOnly || c.createOnly) expect(keys, `${o.key}.${c.key}`).not.toContain(c.key);
      }
      expect(keys).not.toContain("created_at");
      expect(keys).not.toContain("org_id");
    }
    expect(bulkEditableColumns(diag).map((c) => c.key)).toContain("chronic");
    expect(bulkEditableColumns(diag).map((c) => c.key)).not.toContain("code");
  });
});

describe("planBulkEdit", () => {
  it("accepts a valid value through the field's own rule and de-duplicates ids", () => {
    const p = planBulkEdit(diag, { op: "set", ids: [A, A, B], field: "chronic", value: true });
    expect(p).toEqual(expect.objectContaining({ ok: true, ids: [A, B], value: true }));
    if (p.ok) expect(p.column.key).toBe("chronic");
  });

  it("keeps false as a value (not a clear)", () => {
    const p = planBulkEdit(diag, { op: "set", ids: [A], field: "top30", value: false });
    expect(p.ok && p.value).toBe(false);
  });

  it("clears an optional field to null", () => {
    const p = planBulkEdit(diag, { op: "clear", ids: [A], field: "short_description" });
    expect(p).toEqual(expect.objectContaining({ ok: true, value: null }));
  });

  it("refuses to clear a yes/no field or a NOT NULL column", () => {
    expect(planBulkEdit(diag, { op: "clear", ids: [A], field: "chronic" })).toEqual({
      ok: false,
      error: expect.stringMatching(/cannot be cleared/),
    });
    const groups = requirePortalObject("ref_condition_groups");
    expect(planBulkEdit(groups, { op: "clear", ids: [A], field: "sort" })).toEqual({
      ok: false,
      error: expect.stringMatching(/cannot be cleared/),
    });
    expect(planBulkEdit(groups, { op: "set", ids: [A], field: "sort", value: 3 }).ok).toBe(true);
  });

  it("refuses to clear a required field", () => {
    const p = planBulkEdit(entries, { op: "clear", ids: [A], field: "section" });
    expect(p).toEqual({ ok: false, error: expect.stringMatching(/required/) });
  });

  it("refuses a blank value for set (that is a clear) and an invalid value", () => {
    expect(
      planBulkEdit(diag, { op: "set", ids: [A], field: "short_description", value: "  " }).ok,
    ).toBe(false);
    const bad = planBulkEdit(diag, { op: "set", ids: [A], field: "chronic", value: "yes" });
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/yes or no/) });
    const link = planBulkEdit(diag, {
      op: "set",
      ids: [A],
      field: "condition_group_id",
      value: "x",
    });
    expect(link.ok).toBe(false);
  });

  it("refuses unknown, read-only, create-only and title fields", () => {
    for (const field of ["nope", "org_id", "id", "created_at", "code"]) {
      expect(planBulkEdit(diag, { op: "set", ids: [A], field, value: "x" }), field).toEqual({
        ok: false,
        error: "That field cannot be edited in bulk.",
      });
    }
    expect(planBulkEdit(entries, { op: "set", ids: [A], field: "source_key", value: "x" }).ok).toBe(
      false,
    );
  });

  it("caps the number of records and rejects bad ids", () => {
    const many = Array.from(
      { length: BULK_EDIT_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(planBulkEdit(diag, { op: "set", ids: many, field: "chronic", value: true })).toEqual({
      ok: false,
      error: `Select at most ${BULK_EDIT_MAX} records at a time.`,
    });
    expect(
      planBulkEdit(diag, {
        op: "set",
        ids: many.slice(0, BULK_EDIT_MAX),
        field: "chronic",
        value: true,
      }).ok,
    ).toBe(true);
    expect(planBulkEdit(diag, { op: "set", ids: [], field: "chronic", value: true }).ok).toBe(
      false,
    );
    expect(
      planBulkEdit(diag, { op: "set", ids: ["1; drop"], field: "chronic", value: true }).ok,
    ).toBe(false);
  });

  it("checks text length and select options like a single edit", () => {
    const long = "x".repeat(501);
    expect(
      planBulkEdit(diag, { op: "set", ids: [A], field: "short_description", value: long }).ok,
    ).toBe(false);
    const classes = requirePortalObject("ref_medication_classes");
    expect(
      planBulkEdit(classes, { op: "set", ids: [A], field: "class", value: "not-a-class" }).ok,
    ).toBe(false);
  });
});

describe("bulk tags", () => {
  it("needs a change and refuses the same tag in add and remove", () => {
    expect(bulkTagSchema.safeParse({ ids: [A], add: [], remove: [] }).success).toBe(false);
    expect(bulkTagSchema.safeParse({ ids: [A], add: [T1], remove: [T1] }).success).toBe(false);
    const ok = bulkTagSchema.safeParse({ ids: [A, A], add: [T1, T1], remove: [T2] });
    expect(ok.success && ok.data).toEqual({ ids: [A], add: [T1], remove: [T2] });
  });

  it("diffs a record's tags", () => {
    expect(diffTagSets([T1], [T2])).toEqual({ add: [T2], remove: [T1] });
    expect(diffTagSets([T1, T2], [T2, T1])).toEqual({ add: [], remove: [] });
  });

  it("adds only the pairs a record does not have yet", () => {
    expect(tagRowsToAdd([A, B], [T1], [{ record_id: A, tag_id: T1 }])).toEqual([
      { record_id: B, tag_id: T1 },
    ]);
  });
});

describe("bulk result", () => {
  it("counts updated and skipped", () => {
    expect(bulkResult(5, 3)).toEqual({ requested: 5, updated: 3, skipped: 2 });
    expect(bulkResult(2, 9)).toEqual({ requested: 2, updated: 2, skipped: 0 });
    expect(bulkResultMessage(bulkResult(3, 3))).toBe("Updated 3 records.");
    expect(bulkResultMessage(bulkResult(3, 1))).toMatch(/Updated 1 record; 2 skipped/);
    expect(bulkResultMessage(bulkResult(2, 0))).toMatch(/^No changes/);
  });
});

describe("tag filter SQL", () => {
  it("compiles to a parameterised exists over portal_record_tags", () => {
    const bag = new ParamBag();
    const sql = compilePortalTagFilter(diag, [T1, T1, "not-a-uuid", T2], bag);
    expect(sql).toContain("public.portal_record_tags prt");
    expect(sql).toContain("prt.record_id = c.id");
    expect(sql).not.toContain(T1);
    expect(sql).not.toContain("ref_diagnoses");
    expect(bag.params).toEqual(["ref_diagnoses", [T1, T2]]);
  });

  it("is a no-op without tags and joins the other predicates", () => {
    expect(compilePortalTagFilter(diag, [], new ParamBag())).toBe("true");
    const registry = buildPortalFieldRegistry(diag);
    const none = compilePortalPredicate(diag, registry, null, null);
    expect(none.sql).toBe("true");
    const both = compilePortalPredicate(diag, registry, null, "I10", "UTC", [T1]);
    expect(both.sql).toMatch(/ilike .* and exists/);
    expect(both.params).toEqual(["%I10%", "ref_diagnoses", [T1]]);
  });
});
