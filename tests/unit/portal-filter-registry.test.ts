import { describe, expect, it } from "vitest";

import { and, cond } from "@/lib/filters/ast";
import { InvalidOperatorError, UnknownFieldError } from "@/lib/filters/field-registry";
import { compileFilter, compileOrderBy, FilterCompileError, ParamBag } from "@/lib/filters/to-sql";
import { buildPortalFieldRegistry } from "@/lib/portal/filter-registry";
import { PORTAL_OBJECTS, requirePortalObject } from "@/lib/portal/objects";
import { compilePortalPredicate } from "@/lib/portal/query";

const diag = requirePortalObject("ref_diagnoses");
const registry = buildPortalFieldRegistry(diag);

describe("portal field registry", () => {
  it("exposes only column-backed, filterable fields", () => {
    const meds = buildPortalFieldRegistry(requirePortalObject("ref_medications"));
    expect(meds.get("all_medicine_types")).toBeUndefined(); // array column
    expect(registry.get("long_description")).toBeUndefined(); // long text
    expect(registry.get("chronic")?.type).toBe("boolean");
    expect(registry.get("created_at")?.type).toBe("datetime");
  });

  it("rejects unregistered keys and wrong operators", () => {
    const bad = { include: and(cond("org_id", "eq", "x")) };
    expect(() => compileFilter(bad, registry)).toThrow(UnknownFieldError);
    expect(() =>
      compileFilter({ include: and(cond("chronic", "contains", "x")) }, registry),
    ).toThrow(InvalidOperatorError);
  });

  it("compiles parameterised SQL with values outside the text", () => {
    const { sql, params } = compileFilter(
      { include: and(cond("code", "starts_with", "I1"), cond("chronic", "is_true")) },
      registry,
    );
    expect(sql).toContain("c.code");
    expect(sql).not.toContain("I1");
    expect(params).toContain("I1%");
  });

  it("builds ORDER BY from registry identifiers only", () => {
    expect(compileOrderBy([{ field: "code", dir: "asc" }], registry)).toBe("c.code asc nulls last");
    expect(() => compileOrderBy([{ field: "drop table", dir: "asc" }], registry)).toThrow(
      UnknownFieldError,
    );
    expect(() => compileOrderBy([{ field: "long_description", dir: "asc" }], registry)).toThrow();
  });

  it("every registered object builds a registry and compiles its default sort", () => {
    for (const o of PORTAL_OBJECTS) {
      const r = buildPortalFieldRegistry(o);
      expect(() => compileOrderBy(o.defaultSort, r), o.key).not.toThrow();
    }
  });

  it("link columns are uuid selects", () => {
    expect(registry.get("condition_group_id")?.source).toMatchObject({
      kind: "column",
      sqlType: "uuid",
    });
    expect(() =>
      compileFilter({ include: and(cond("condition_group_id", "in", ["a", "b"])) }, registry),
    ).not.toThrow(FilterCompileError);
  });
});

describe("compilePortalPredicate", () => {
  it("combines filter and free-text search with one shared param bag", () => {
    const { sql, params } = compilePortalPredicate(
      diag,
      registry,
      { include: and(cond("chronic", "is_true")) },
      "100%_x",
    );
    expect(sql).toContain("c.chronic");
    expect(sql).toContain("c.code ilike");
    expect(sql).toContain("escape");
    expect(params).toEqual(["%100\\%\\_x%"]);
  });

  it("is true for no filter and no search", () => {
    expect(compilePortalPredicate(diag, registry, null, "  ").sql).toBe("true");
  });

  it("uses indexes unique to the bag", () => {
    const bag = new ParamBag();
    compileFilter({ include: and(cond("code", "eq", "A")) }, registry, {}, bag);
    expect(bag.params).toEqual(["A"]);
  });
});
